/**
 * Zustand global store for PulSeed dashboard.
 * Holds goals, sessions, decisions and SSE connection state.
 */
import { create } from 'zustand';
import { createSSEConnection } from './sse';
import type { GoalSummary, SessionSummary, DecisionRecord, SSEEvent } from './sse';

export type { GoalSummary, SessionSummary, DecisionRecord };

interface PulSeedStore {
  // State
  goals: GoalSummary[];
  sessions: SessionSummary[];
  decisions: DecisionRecord[];
  connected: boolean;
  lastUpdate: number | null;

  // Internal
  _sseCleanup: (() => void) | null;

  // Actions
  initialize: () => void;
  cleanup: () => void;
  refreshGoals: () => Promise<void>;
  refreshSessions: () => Promise<void>;

  // Internal setters
  setGoals: (goals: GoalSummary[]) => void;
  updateGoal: (goalId: string, data: GoalSummary) => void;
  setSessions: (sessions: SessionSummary[]) => void;
  updateSession: (sessionId: string, data: SessionSummary) => void;
  addDecision: (decision: DecisionRecord) => void;
  setConnected: (connected: boolean) => void;
}

export const usePulSeedStore = create<PulSeedStore>((set, get) => ({
  goals: [],
  sessions: [],
  decisions: [],
  connected: false,
  lastUpdate: null,
  _sseCleanup: null,

  setGoals: (goals) => set({ goals, lastUpdate: Date.now() }),

  updateGoal: (goalId, data) =>
    set((state) => ({
      goals: state.goals.map((g) => (g.id === goalId ? { ...g, ...data } : g)),
      lastUpdate: Date.now(),
    })),

  setSessions: (sessions) => set({ sessions, lastUpdate: Date.now() }),

  updateSession: (sessionId, data) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...data } : s)),
      lastUpdate: Date.now(),
    })),

  addDecision: (decision) =>
    set((state) => ({
      decisions: [decision, ...state.decisions].slice(0, 50),
      lastUpdate: Date.now(),
    })),

  setConnected: (connected) => set({ connected }),

  initialize: () => {
    const state = get();
    // Prevent double-initialization
    if (state._sseCleanup) return;

    // Fetch initial data
    get().refreshGoals();
    get().refreshSessions();

    // Fetch initial decisions
    fetch('/api/decisions')
      .then((r) => r.json())
      .then((data: DecisionRecord[]) => {
        if (Array.isArray(data)) {
          set({ decisions: data, lastUpdate: Date.now() });
        }
      })
      .catch(() => {
        // Silently fail — dashboard degrades gracefully
      });

    // Set up SSE
    const cleanup = createSSEConnection(
      '/api/events',
      (event: SSEEvent) => handleSSEEvent(event, get, set),
      () => {
        set({ connected: false });
      }
    );

    set({ _sseCleanup: cleanup });
  },

  cleanup: () => {
    const { _sseCleanup } = get();
    _sseCleanup?.();
    set({ _sseCleanup: null, connected: false });
  },

  refreshGoals: async () => {
    try {
      const res = await fetch('/api/goals');
      const data = await res.json();
      if (Array.isArray(data)) {
        set({ goals: data as GoalSummary[], lastUpdate: Date.now() });
      }
    } catch {
      // Silently fail
    }
  },

  refreshSessions: async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (Array.isArray(data)) {
        set({ sessions: data as SessionSummary[], lastUpdate: Date.now() });
      }
    } catch {
      // Silently fail
    }
  },
}));

function handleSSEEvent(
  event: SSEEvent,
  get: () => PulSeedStore,
  set: (partial: Partial<PulSeedStore>) => void
) {
  const store = get();

  switch (event.type) {
    case 'connected':
      set({ connected: true });
      break;

    case 'goal_updated':
      store.updateGoal(event.goalId, event.data);
      break;

    case 'session_updated':
      store.updateSession(event.sessionId, event.data);
      break;

    case 'decision_recorded':
      store.addDecision(event.data);
      break;

    case 'trust_changed':
      store.updateGoal(event.goalId, {
        ...store.goals.find((g) => g.id === event.goalId)!,
        trust: event.trust,
      });
      break;

    case 'gap_changed':
      store.updateGoal(event.goalId, {
        ...store.goals.find((g) => g.id === event.goalId)!,
        gap: event.gap,
      });
      break;
  }
}
