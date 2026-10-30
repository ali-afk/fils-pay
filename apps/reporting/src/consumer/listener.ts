import { Client, type Pool } from "pg";
import type { ReportingConfig } from "../config.js";
import { runConsumerPass } from "./runConsumerPass.js";

/**
 * Must match the channel the outbox trigger notifies on (db/migrations);
 * a NOTIFY on any other channel is silently ignored.
 */
const NOTIFY_CHANNEL = "outbox_events_channel";

/** R13: burst coalescing window — NOTIFYs reset a trailing timer, so a
 *  burst of notifications within this window runs exactly one pass. */
export const NOTIFY_DEBOUNCE_MS = 1_000;

/** R14: upper bound for the LISTEN reconnect backoff (doubles from the
 *  poll cadence). */
export const LISTEN_RECONNECT_MAX_DELAY_MS = 60_000;

/** R14: application_name the LISTEN client connects under — identifies this
 *  worker's pinned connection in pg_stat_activity for ops and tests. */
export const LISTENER_APPLICATION_NAME = "reporting-listener";

export interface ReportingConsumerHandle {
  stop(): Promise<void>;
}

/** A trailing (coalescing) debounce: every `schedule()` resets the timer,
 *  and the action fires exactly once, `delayMs` after the LAST schedule —
 *  never once per schedule within a burst. `cancel()` prevents a pending
 *  fire (called on stop so no timer outlives the consumer). */
export function createTrailingDebounce(delayMs: number, action: () => void): { schedule(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        action();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Starts the reporting consumer: a dedicated LISTEN connection on the
 * webhook dispatcher's existing trigger/channel for near-real-time reaction
 * to fresh outbox_events inserts, plus a poll-interval safety net that
 * guarantees no event is stuck forever even if a NOTIFY is missed.
 *
 * `runPass` is injectable so tests can count pass triggers without touching
 * the shared outbox — production always uses runConsumerPass.
 */
export function startReportingConsumer(
  pool: Pool,
  config: ReportingConfig,
  runPass: (pool: Pool, config: ReportingConfig) => Promise<unknown> = runConsumerPass,
): ReportingConsumerHandle {
  let running = false;
  let stopped = false;

  const triggerPass = (): void => {
    if (running || stopped) return;
    running = true;
    runPass(pool, config)
      .catch((err: unknown) => {
        // A thrown error from one pass must never crash the listener or the
        // process — the next NOTIFY, reconnect, or poll tick simply tries again.
        console.error("[reporting/consumer] consumer pass failed", err);
      })
      .finally(() => {
        running = false;
      });
  };

  // R13: NOTIFYs are coalesced into ONE pass per burst. This is distinct
  // from the `running` re-entrancy guard above: the guard serializes
  // overlapping passes, the debounce stops a burst of notifications from
  // queueing one pass per notification.
  const debouncedPass = createTrailingDebounce(NOTIFY_DEBOUNCE_MS, triggerPass);

  // R14: the LISTEN connection is not trusted to stay up — on `error` or
  // `end` a fresh dedicated Client is connected and re-LISTENs after a
  // poll-cadence backoff, unless the consumer is already stopped.
  let listenClient: Client | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let connectPromise: Promise<void> = Promise.resolve();

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    reconnectAttempts += 1;
    const delay = Math.min(
      config.reportingPollIntervalMs * 2 ** (reconnectAttempts - 1),
      LISTEN_RECONNECT_MAX_DELAY_MS,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectListener();
    }, delay);
  };

  const connectListener = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const isReconnect = reconnectAttempts > 0;
    const client = new Client({
      connectionString: config.databaseUrl,
      application_name: LISTENER_APPLICATION_NAME,
    });
    listenClient = client;

    const isCurrent = (): boolean => listenClient === client && !stopped;

    client.on("error", (err: Error) => {
      console.error("[reporting/consumer] LISTEN client error", err);
      if (isCurrent()) scheduleReconnect();
    });
    client.on("end", () => {
      if (isCurrent()) scheduleReconnect();
    });
    client.on("notification", () => {
      debouncedPass.schedule();
    });

    const connecting = client
      .connect()
      .then(async () => {
        await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
        if (!isCurrent()) return;
        reconnectAttempts = 0;
        if (isReconnect) {
          console.log("[reporting/consumer] LISTEN re-established");
        }
        // Run one pass immediately on (re)connect so a restart or reconnect
        // resumes and catches up on any backlog without waiting for the
        // first NOTIFY or poll tick.
        triggerPass();
      })
      .catch((err: unknown) => {
        if (isCurrent()) {
          // NOTIFY is an optimization, not the sole mechanism — the poll
          // interval below still guarantees eventual processing even if the
          // LISTEN connection never comes up.
          console.error("[reporting/consumer] failed to establish LISTEN connection", err);
        }
      });

    connectPromise = connecting;
    return connecting;
  };

  void connectListener();

  const interval = setInterval(triggerPass, config.reportingPollIntervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      debouncedPass.cancel();
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      await connectPromise;
      if (listenClient !== undefined) {
        await listenClient.end().catch(() => {});
        listenClient = undefined;
      }
    },
  };
}
