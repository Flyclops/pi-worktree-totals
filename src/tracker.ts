/**
 * Per-session-runtime Worktree Cost tracker: resolves the Worktree once,
 * then refreshes incrementally, folding in the live Session from pi's
 * in-memory entries (spec Q19). It doesn't depend on pi's runtime, so it can
 * be tested directly.
 */
import type { WorktreeTotals } from "./aggregate.ts";
import { parseSessionEntries } from "./session-file.ts";
import { WorktreeTotalsIndex } from "./worktree-totals.ts";
import { resolveWorktree, type Worktree } from "./worktree.ts";

/** The subset of pi's ReadonlySessionManager the tracker reads. */
export interface SessionSource {
  getCwd(): string;
  getSessionDir(): string;
  getSessionFile(): string | undefined;
  getHeader(): unknown;
  getEntries(): readonly unknown[];
}

/** Label used for the live Session when it has no file (`--no-session`). */
export const LIVE_PATH = "(current session, not saved)";

export class WorktreeTotalsTracker {
  readonly worktree: Worktree;
  private readonly index: WorktreeTotalsIndex;

  private constructor(worktree: Worktree, index: WorktreeTotalsIndex) {
    this.worktree = worktree;
    this.index = index;
  }

  static async start(
    session: SessionSource,
    agentDir: string,
    resolve: typeof resolveWorktree = resolveWorktree,
  ): Promise<WorktreeTotalsTracker> {
    const worktree = await resolve(session.getCwd());
    const index = new WorktreeTotalsIndex({
      activeSessionDir: session.getSessionDir(),
      agentDir,
      worktreeRoot: worktree.root,
      lifetimeStart: worktree.lifetimeStart,
    });
    return new WorktreeTotalsTracker(worktree, index);
  }

  /**
   * Refresh from disk plus the live Session. The live Session stands in for
   * its own file, if any, because memory is never behind disk.
   *
   * Cost: the index refresh, plus O(live entries) with no JSON parsing.
   */
  refresh(session: SessionSource): Promise<WorktreeTotals> {
    const live = parseSessionEntries(
      session.getSessionFile() ?? LIVE_PATH,
      session.getHeader(),
      session.getEntries(),
    );
    return this.index.refresh(live ? [live] : []);
  }
}
