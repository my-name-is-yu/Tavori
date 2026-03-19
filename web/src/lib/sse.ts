/**
 * SSE client utility with auto-reconnect and exponential backoff.
 */

export type SSEEvent =
  | { type: 'connected' }
  | { type: 'heartbeat' }
  | { type: 'goal_updated'; goalId: string; data: GoalSummary }
  | { type: 'session_updated'; sessionId: string; data: SessionSummary }
  | { type: 'decision_recorded'; goalId: string; data: DecisionRecord }
  | { type: 'trust_changed'; goalId: string; trust: number }
  | { type: 'gap_changed'; goalId: string; gap: number };

export interface GoalSummary {
  id: string;
  name: string;
  status: string;
  gap?: number;
  trust?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface SessionSummary {
  id: string;
  goalId?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  [key: string]: unknown;
}

export interface DecisionRecord {
  id: string;
  goal_id: string;
  goal_name?: string;
  decision: string;
  timestamp: string;
  strategy_id?: string;
  what_worked?: string[];
  what_failed?: string[];
  suggested_next?: string[];
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/**
 * Creates an SSE connection to the given URL.
 * Auto-reconnects with exponential backoff on error.
 * Returns a cleanup function that stops reconnection and closes the connection.
 */
export function createSSEConnection(
  url: string,
  onEvent: (event: SSEEvent) => void,
  onError?: (error: Event) => void
): () => void {
  let es: EventSource | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function connect() {
    if (stopped) return;

    es = new EventSource(url);

    es.onmessage = (e: MessageEvent) => {
      retryCount = 0; // reset backoff on successful message
      try {
        const event = JSON.parse(e.data) as SSEEvent;
        if (event.type === 'heartbeat') return; // ignore heartbeats
        onEvent(event);
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = (e: Event) => {
      onError?.(e);
      es?.close();
      es = null;

      if (stopped) return;

      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
      retryCount++;
      retryTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return function cleanup() {
    stopped = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    es?.close();
    es = null;
  };
}
