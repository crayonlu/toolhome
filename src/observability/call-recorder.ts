import type { ToolCallDraft } from '../domain/models.js';
import type { Logger } from './logger.js';
import type { Store } from '../storage/store.js';

const FLUSH_INTERVAL_MS = 50;
const MAX_QUEUE = 10_000;
const RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Fire-and-forget recorder for MCP tool calls.
 *
 * The data plane never awaits recording: drafts are queued and flushed in
 * batches inside a single transaction. If the queue overflows we drop the
 * newest drafts, count them, and log a warning once — the call path must never
 * be slowed down or fail because of observability.
 *
 * Retention: rows older than `retentionDays` are deleted hourly in small
 * batches (a `trim_tool_calls` SQL trigger caps total rows as a backstop).
 */
export class CallRecorder {
  readonly #store: Store;
  readonly #logger: Logger;
  readonly #retentionDays: number;
  #queue: ToolCallDraft[] = [];
  #dropped = 0;
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #retentionTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(store: Store, logger: Logger, retentionDays = 30) {
    this.#store = store;
    this.#logger = logger;
    this.#retentionDays = Math.max(0, Math.floor(retentionDays));
    this.#flushTimer = setInterval(() => void this.#flush(), FLUSH_INTERVAL_MS);
    // Background maintenance must not hold a CLI process open: a command that
    // finished its work should exit even though the recorder still has timers.
    this.#flushTimer.unref();
    if (this.#retentionDays > 0) {
      this.#retentionTimer = setInterval(
        () => void this.#runRetention(),
        RETENTION_CHECK_INTERVAL_MS,
      );
      this.#retentionTimer.unref();
    }
  }

  record(draft: ToolCallDraft): void {
    if (this.#closed) return;
    if (this.#queue.length >= MAX_QUEUE) {
      this.#dropped += 1;
      if (this.#dropped === 1) {
        this.#logger.warn('Call recorder queue full, dropping call records', {
          queue: this.#queue.length,
        });
      }
      return;
    }
    this.#queue.push(draft);
  }

  async flush(): Promise<void> {
    await this.#flush();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#flushTimer = null;
    this.#retentionTimer = null;
    await this.#flush();
  }

  async #flush(): Promise<void> {
    const batch = this.#queue;
    this.#queue = [];
    if (batch.length === 0) return;
    try {
      this.#store.transaction(() => {
        this.#store.insertToolCalls(batch);
      });
      if (this.#dropped > 0) {
        this.#logger.warn('Call recorder dropped records', { dropped: this.#dropped });
        this.#dropped = 0;
      }
    } catch (error) {
      // Drop the batch; never retry into an unbounded loop.
      this.#logger.warn('Failed to persist tool call records', {
        count: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #runRetention(): Promise<void> {
    const before = new Date(Date.now() - this.#retentionDays * 86_400_000).toISOString();
    try {
      const deleted = this.#store.deleteOldToolCalls(before);
      if (deleted > 0) {
        this.#logger.info('Tool call retention cleanup', { deleted, before });
      }
    } catch (error) {
      this.#logger.warn('Tool call retention cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
