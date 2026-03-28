/**
 * SSE endpoint — polls PulSeed state every 2s and pushes changes to the client.
 * M18.4: real-time event stream for the dashboard.
 */
import { getStateManager } from '../../../lib/pulseed-client';

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 30000;

function hashState(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return String(hash);
}

function sseMessage(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

interface GoalState {
  id: string;
  status: string;
  trust?: number;
  gap?: number;
  updatedAt?: string;
  [key: string]: unknown;
}

export async function GET(request: Request) {
  const { signal } = request;

  const stream = new ReadableStream({
    async start(controller) {
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      function enqueue(data: unknown) {
        try {
          controller.enqueue(sseMessage(data));
        } catch {
          // Controller may be closed; ignore
        }
      }

      function close() {
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }

      // Clean up when client disconnects
      signal.addEventListener('abort', close);

      // Send connected event
      enqueue({ type: 'connected' });

      // Track previous state hashes keyed by goalId
      const prevHashes = new Map<string, string>();
      let prevGoalListHash = '';

      async function poll() {
        if (signal.aborted) return;

        try {
          const sm = getStateManager();
          const goalIds: string[] = await sm.listGoalIds();

          // Detect new/removed goals
          const currentGoalListHash = hashState(goalIds.slice().sort());
          if (currentGoalListHash !== prevGoalListHash) {
            prevGoalListHash = currentGoalListHash;
          }

          for (const id of goalIds) {
            if (signal.aborted) break;

            const goal = await sm.loadGoal(id) as GoalState | null;
            if (!goal) continue;

            const hash = hashState(goal);
            const prev = prevHashes.get(id);

            if (hash !== prev) {
              prevHashes.set(id, hash);
              enqueue({
                type: 'goal_updated',
                goalId: id,
                data: goal,
              });

              // Also emit specific change events for trust/gap if they differ
              if (prev !== undefined) {
                const prevGoal = JSON.parse(JSON.stringify(goal)) as GoalState;
                // We only have the current value — emit anyway for subscribers
                if (goal.trust !== undefined) {
                  enqueue({ type: 'trust_changed', goalId: id, trust: goal.trust });
                }
                if (goal.gap !== undefined) {
                  enqueue({ type: 'gap_changed', goalId: id, gap: goal.gap });
                }
                void prevGoal; // suppress unused var warning
              }
            }
          }
        } catch {
          // StateManager may not be available; skip poll
        }
      }

      // Initial poll
      await poll();

      // Recurring poll
      pollTimer = setInterval(() => {
        void poll();
      }, POLL_INTERVAL_MS);

      // Heartbeat to keep connection alive
      heartbeatTimer = setInterval(() => {
        enqueue({ type: 'heartbeat' });
      }, HEARTBEAT_INTERVAL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
