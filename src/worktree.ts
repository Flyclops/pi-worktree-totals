/**
 * Resolve the Worktree (see GLOSSARY.md) for a directory, and when its
 * Worktree Lifetime started.
 *
 * - Linked worktree: root is its top level; lifetime starts when git created
 *   `<common-git-dir>/worktrees/<name>` (spec Q10). Recreating a worktree at
 *   the same path creates a fresh admin folder, so the lifetime resets.
 * - Main checkout: root is its top level; no lifetime bound (spec Q9).
 * - Not in git: root is the directory itself; no lifetime bound (spec Q7).
 */
import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export type WorktreeKind = "linked" | "main" | "none";

export interface Worktree {
  /** Canonical (symlink-resolved) absolute path of the Worktree. */
  root: string;
  /** Start of the Worktree Lifetime, or null for no bound. */
  lifetimeStart: Date | null;
  kind: WorktreeKind;
}

/** Runs git in `cwd` with `args`, resolving stdout or rejecting. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

/** Minimal stat shape needed to work out when a folder was created. */
export interface StatLike {
  birthtimeMs: number;
  mtimeMs: number;
}
export type StatFn = (path: string) => Promise<StatLike>;

const execFileAsync = promisify(execFile);

/** Default GitRunner. Forces the C locale so stderr text is predictable. */
export const runGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    timeout: 5_000,
  });
  return stdout;
};

/** Thrown when git fails for a reason other than "not a git repository". */
export class WorktreeResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorktreeResolutionError";
  }
}

/**
 * Resolve the Worktree containing `cwd`.
 *
 * Cost: one git process plus O(1) stats (O(files in the worktree admin
 * folder) on filesystems without birthtime).
 */
export async function resolveWorktree(
  cwd: string,
  git: GitRunner = runGit,
  statFn: StatFn = stat,
): Promise<Worktree> {
  let out: string;
  try {
    out = await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]);
  } catch (err) {
    if (isNotARepo(err)) {
      return { root: await canonical(cwd), lifetimeStart: null, kind: "none" };
    }
    throw new WorktreeResolutionError(
      `git rev-parse failed in ${cwd}`,
      { cause: err },
    );
  }

  const [top, gitDir, commonDir] = out.trim().split("\n");
  if (!top || !gitDir || !commonDir) {
    throw new WorktreeResolutionError(
      `unexpected git rev-parse output in ${cwd}: ${JSON.stringify(out)}`,
    );
  }

  const root = await canonical(top);
  const [gitDirReal, commonDirReal] = await Promise.all([
    canonical(gitDir),
    canonical(commonDir),
  ]);
  if (gitDirReal === commonDirReal) {
    return { root, lifetimeStart: null, kind: "main" };
  }
  const lifetimeStart = await folderCreationTime(gitDirReal, statFn);
  return { root, lifetimeStart, kind: "linked" };
}

/**
 * When `dir` was created. Uses birthtime when the filesystem reports one.
 * Otherwise falls back to the earliest mtime among the folder and its
 * immediate children. A worktree admin folder's `commondir` file is written
 * once at creation and never touched again.
 */
export async function folderCreationTime(
  dir: string,
  statFn: StatFn = stat,
): Promise<Date> {
  const own = await statFn(dir);
  if (own.birthtimeMs > 0) return new Date(own.birthtimeMs);

  let earliest = own.mtimeMs;
  for (const name of await readdir(dir)) {
    const s = await statFn(join(dir, name));
    if (s.mtimeMs < earliest) earliest = s.mtimeMs;
  }
  return new Date(earliest);
}

function isNotARepo(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && stderr.includes("not a git repository");
}

/** realpath when the path exists; the plain path otherwise. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // Deliberate fallback, not a swallowed error: a missing path can't be
    // resolved further, and the unresolved path is still the best identity.
    return p;
  }
}
