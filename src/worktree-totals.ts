/**
 * Compute the Worktree Cost from pi's session files (ADR-0001), and keep it
 * fresh cheaply (issue 04).
 *
 * Pipeline per refresh: list files in the scan set → for each file, decide
 * from the cache whether it needs reading → read headers of new files and
 * keep those whose cwd is within the Worktree → parse member files
 * incrementally → aggregate.
 *
 * Cost per refresh, F files in the scan set, M of them members:
 * - one readdir per scanned folder
 * - one stat per member file (non-members are never re-checked: a Session's
 *   cwd never changes, per pi docs/sessions.md)
 * - one header read per new file
 * - O(appended bytes) parsing for changed members
 * - O(E log M) aggregation over E billed entries
 */
import { stat } from "node:fs/promises";
import { aggregate, type WorktreeTotals } from "./aggregate.ts";
import {
  createCwdCanonicalizer,
  detectLayout,
  isWithin,
  listSessionFiles,
  type SessionLayout,
} from "./discovery.ts";
import {
  type ParsedSession,
  type ParseState,
  readSessionFile,
  readSessionHeader,
  toParsedSession,
} from "./session-file.ts";

export interface WorktreeTotalsInput {
  /** `ctx.sessionManager.getSessionDir()` */
  activeSessionDir: string;
  /** pi's `getAgentDir()` */
  agentDir: string;
  /** Canonical Worktree root (see resolveWorktree). */
  worktreeRoot: string;
  lifetimeStart: Date | null;
}

type CacheEntry =
  | { kind: "member"; size: number; mtimeMs: number; state: ParseState }
  /** Header cwd outside the Worktree. Never re-checked. */
  | { kind: "other" }
  /** Not a pi session. Re-checked only if the file changes. */
  | { kind: "invalid"; size: number; mtimeMs: number };

const IO_CONCURRENCY = 16;

/** One-shot Worktree Cost. */
export function computeWorktreeTotals(
  input: WorktreeTotalsInput,
): Promise<WorktreeTotals> {
  return new WorktreeTotalsIndex(input).refresh();
}

/**
 * Long-lived, incrementally refreshed Worktree Cost for one pi session
 * runtime. Concurrent refresh() calls are serialized and coalesced.
 */
export class WorktreeTotalsIndex {
  /** Work counters, for tests and benchmarks. */
  readonly stats = { stats: 0, headerReads: 0, fileReads: 0 };

  private readonly input: WorktreeTotalsInput;
  private readonly layout: SessionLayout;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly canon = createCwdCanonicalizer();
  private tail: Promise<unknown> = Promise.resolve();
  private queued: Promise<WorktreeTotals> | undefined;

  constructor(input: WorktreeTotalsInput) {
    this.input = input;
    this.layout = detectLayout(input.activeSessionDir, input.agentDir);
  }

  /**
   * Bring the index up to date and return the Worktree Cost. `extra`
   * sessions (e.g. the live in-memory Session) are aggregated alongside the
   * files, with the same dedupe. An extra session replaces the file with the
   * same path, so a Session is never listed twice.
   */
  refresh(extra: readonly ParsedSession[] = []): Promise<WorktreeTotals> {
    if (this.queued) return this.queued;
    // A previous refresh's failure was already delivered to its own caller;
    // it must not block later refreshes.
    const run = this.tail
      .catch(() => undefined)
      .then(() => {
        this.queued = undefined;
        return this.doRefresh(extra);
      });
    this.queued = run;
    this.tail = run;
    return run;
  }

  private async doRefresh(
    extra: readonly ParsedSession[],
  ): Promise<WorktreeTotals> {
    const files = await listSessionFiles(this.layout);
    const present = new Set(files);
    for (const path of this.cache.keys()) {
      if (!present.has(path)) this.cache.delete(path); // ADR-0001: deleted = gone
    }

    const warnings: string[] = [];
    await mapLimit(files, IO_CONCURRENCY, (path) =>
      this.update(path).catch((err: Error) => {
        // One unreadable file must not hide the whole Worktree Cost.
        warnings.push(`${path}: ${err.message}`);
      }),
    );

    const sessions: ParsedSession[] = [...extra];
    const replaced = new Set(extra.map((s) => s.path));
    for (const [path, entry] of this.cache) {
      if (entry.kind === "member") {
        if (replaced.has(path)) continue;
        sessions.push(toParsedSession(path, entry.state));
      } else if (entry.kind === "invalid") {
        warnings.push(`${path}: not a pi session file`);
      }
    }
    return aggregate(sessions, this.input.lifetimeStart, warnings);
  }

  /** Bring one file's cache entry up to date. */
  private async update(path: string): Promise<void> {
    const cached = this.cache.get(path);
    if (cached?.kind === "other") return;

    let st;
    try {
      this.stats.stats++;
      st = await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache.delete(path); // Deleted since listing.
        return;
      }
      throw err;
    }
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return; // Unchanged.
    }

    if (cached?.kind !== "member") {
      this.stats.headerReads++;
      const head = await readSessionHeader(path);
      if (head.kind === "incomplete") return; // Still being written; retry.
      if (head.kind === "invalid") {
        this.cache.set(path, { kind: "invalid", size: st.size, mtimeMs: st.mtimeMs });
        return;
      }
      const cwd = await this.canon(head.header.cwd);
      if (!isWithin(cwd, this.input.worktreeRoot)) {
        this.cache.set(path, { kind: "other" });
        return;
      }
    }

    this.stats.fileReads++;
    const prev = cached?.kind === "member" ? cached.state : undefined;
    const { read, header } = await readSessionFile(path, prev);
    if (read) {
      this.cache.set(path, { kind: "member", ...read });
    } else if (header === "invalid") {
      this.cache.set(path, { kind: "invalid", size: st.size, mtimeMs: st.mtimeMs });
    }
  }
}

/** Promise.all with at most `limit` tasks in flight. Preserves order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}
