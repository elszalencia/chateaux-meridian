// EventIndexer: polls Soroban RPC `getEvents` for the payment_plan contract with a stored cursor
// and writes every event to `events.jsonl` (idempotent by event id). The cursor is saved only after
// the page's events are written, so a crash in between replays that page on the next start and the
// duplicates are dropped by the store: a restart resumes with no gaps and no duplicates.
//
// RPC keeps events for about 7 days, so the indexer must run well inside that window; a cursor
// older than the retention window cannot be resumed and is reported, not silently skipped.

import type { rpc } from '@stellar/stellar-sdk';
import { decodeEvent, type IndexedEvent } from './events';
import { JsonFile, JsonlStore } from './fileStore';

export interface IndexerCursor {
  contractId: string;
  /** Opaque RPC paging token; null until the first page was read. */
  cursor: string | null;
  /** Latest ledger the RPC had when the cursor was saved. */
  latestLedger: number;
  updatedAt: string;
}

export type GetEventsFn = (req: rpc.Api.GetEventsRequest) => Promise<rpc.Api.GetEventsResponse>;

export interface EventIndexerOptions {
  contractId: string;
  dataDir: string;
  getEvents: GetEventsFn;
  /** Ledger to start from when there is no cursor yet (the deploy ledger); clamped to retention. */
  startLedger: number;
  /** Oldest ledger the RPC still holds (from getHealth); used to clamp `startLedger`. */
  oldestLedger?: () => Promise<number>;
  pageSize?: number;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

export interface IndexerStats {
  contractId: string;
  events: number;
  fileLines: number;
  cursor: string | null;
  latestLedger: number;
  lastPollAt: string | null;
  lastError: string | null;
  polls: number;
}

/** Ledger of an RPC event cursor: the first part is a TOID, `ledger << 32 | tx/op order`. */
export function cursorLedger(cursor: string | null): number {
  if (!cursor) return 0;
  const toid = /^(\d+)/.exec(cursor)?.[1];
  return toid ? Number(BigInt(toid) >> 32n) : 0;
}

export class EventIndexer {
  readonly events: JsonlStore<IndexedEvent>;
  private readonly cursorFile: JsonFile<IndexerCursor>;
  private state: IndexerCursor;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<number> | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private polls = 0;
  private readonly listeners = new Set<(added: IndexedEvent[]) => void>();

  constructor(private readonly opts: EventIndexerOptions) {
    this.events = new JsonlStore<IndexedEvent>(opts.dataDir, 'events');
    this.cursorFile = new JsonFile<IndexerCursor>(opts.dataDir, 'cursor');
    const saved = this.cursorFile.read();
    // A cursor for another contract (a fresh deploy) is not resumable; start over for this one.
    this.state =
      saved && saved.contractId === opts.contractId
        ? saved
        : { contractId: opts.contractId, cursor: null, latestLedger: 0, updatedAt: new Date(0).toISOString() };
  }

  get cursor(): IndexerCursor {
    return { ...this.state };
  }

  /** Called with the events each poll added (not with replayed duplicates). */
  onEvents(fn: (added: IndexedEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** One catch-up pass: reads pages until the RPC has nothing newer. Returns the events added. */
  pollOnce(): Promise<number> {
    // Overlapping callers (the timer and a receipt waiting for its ledger) share one pass.
    if (!this.running) this.running = this.poll().finally(() => (this.running = null));
    return this.running;
  }

  private async poll(): Promise<number> {
    const limit = this.opts.pageSize ?? 200;
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [this.opts.contractId] }];
    const added: IndexedEvent[] = [];
    try {
      for (;;) {
        let req: rpc.Api.GetEventsRequest;
        if (this.state.cursor) {
          req = { filters, cursor: this.state.cursor, limit };
        } else {
          const oldest = this.opts.oldestLedger ? await this.opts.oldestLedger() : 0;
          req = { filters, startLedger: Math.max(this.opts.startLedger, oldest + 1), limit };
        }
        const res = await this.opts.getEvents(req);
        for (const ev of res.events) {
          const row = decodeEvent(ev);
          if (this.events.put(row)) added.push(row);
        }
        const next = { contractId: this.opts.contractId, cursor: res.cursor || this.state.cursor, latestLedger: res.latestLedger, updatedAt: new Date().toISOString() };
        this.cursorFile.write(next);
        this.state = next;
        // A short page is not the end: RPC scans a bounded ledger window per request and returns a
        // cursor at the end of that window, so keep going until the cursor reaches the tip.
        if (res.events.length < limit && cursorLedger(next.cursor) >= res.latestLedger) break;
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.opts.log?.(`indexer: getEvents failed (${this.lastError}); retrying on the next poll`);
    } finally {
      this.polls += 1;
      this.lastPollAt = new Date().toISOString();
    }
    if (added.length > 0) {
      const counts = new Map<string, number>();
      for (const e of added) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      const summary = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
      this.opts.log?.(`indexer: +${added.length} event(s) up to ledger ${added[added.length - 1]!.ledger} (${summary})`);
      for (const fn of this.listeners) fn(added);
    }
    return added.length;
  }

  /** Polls until the indexer has seen `ledger` (or the timeout passes). Returns whether it did. */
  async waitForLedger(ledger: number, timeoutMs = 30_000, intervalMs = 1_500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.pollOnce();
      if (this.state.latestLedger >= ledger) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.pollOnce();
      if (this.timer) this.timer = setTimeout(() => void tick(), this.opts.pollIntervalMs ?? 5_000);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  stats(): IndexerStats {
    return {
      contractId: this.opts.contractId,
      events: this.events.size,
      fileLines: this.events.lineCount(),
      cursor: this.state.cursor,
      latestLedger: this.state.latestLedger,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      polls: this.polls,
    };
  }

  /** Events of one chain plan, oldest first. */
  eventsForPlan(chainPlanId: number): IndexedEvent[] {
    return this.events
      .all()
      .filter((e) => e.planId === chainPlanId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
