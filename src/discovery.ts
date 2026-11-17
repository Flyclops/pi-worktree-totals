/**
 * Work out which session files might belong to a Worktree (spec, "Session
 * discovery").
 *
 * pi stores sessions in one of two layouts:
 * - Default: `<agentDir>/sessions/--<encoded-cwd>--/*.jsonl`, one folder per
 *   cwd. Sessions from Worktree subfolders, and Sessions whose cwd moved with
 *   /resume, live in *sibling* folders, so we scan them all.
 * - Custom flat (`sessionDir` setting, `--session-dir` flag,
 *   `PI_CODING_AGENT_SESSION_DIR`): one folder holding every cwd.
 *
 * Detection is structural on purpose; we never copy pi's private folder-name
 * encoding. Membership is decided by each file's header `cwd`, never by
 * folder names, because the encoding is lossy.
 */
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export type SessionLayout =
  | { kind: "default"; root: string }
  | { kind: "flat"; dir: string };

const DEFAULT_FOLDER = /^--.*--$/;

/**
 * Classify the active session folder. Pure.
 *
 * An empty folder means an in-memory session (`--no-session`; pi's
 * `SessionManager.inMemory` stores ""). It has no folder of its own, so we
 * assume the default layout. Custom `sessionDir` settings are not visible in
 * that case.
 */
export function detectLayout(
  activeSessionDir: string,
  agentDir: string,
): SessionLayout {
  const defaultRoot = resolve(agentDir, "sessions");
  if (activeSessionDir === "") return { kind: "default", root: defaultRoot };
  const active = resolve(activeSessionDir);
  if (
    dirname(active) === defaultRoot &&
    DEFAULT_FOLDER.test(basename(active))
  ) {
    return { kind: "default", root: defaultRoot };
  }
  return { kind: "flat", dir: active };
}

/**
 * List every candidate `*.jsonl` session file for a layout. A missing folder
 * just means no sessions yet. Other filesystem errors propagate.
 *
 * Cost: one readdir per scanned folder.
 */
export async function listSessionFiles(
  layout: SessionLayout,
): Promise<string[]> {
  if (layout.kind === "flat") return listJsonl(layout.dir);

  const entries = await readdirOrEmpty(layout.root);
  const folders = entries
    .filter((d) => d.isDirectory() && DEFAULT_FOLDER.test(d.name))
    .map((d) => join(layout.root, d.name));
  const nested = await Promise.all(folders.map(listJsonl));
  return nested.flat();
}

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await readdirOrEmpty(dir);
  return entries
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => join(dir, d.name));
}

async function readdirOrEmpty(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * True when `path` is `root` or lies beneath it. Uses separator-aware
 * matching, so `/repo-other` is not within `/repo`.
 */
export function isWithin(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  if (p === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return p.startsWith(prefix);
}

/**
 * Canonicalise session cwds so symlinked paths still match the (realpath)
 * Worktree root. Memoised, since many sessions share one cwd. A cwd that no
 * longer exists keeps its recorded form.
 */
export function createCwdCanonicalizer(): (cwd: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (cwd) => {
    let hit = cache.get(cwd);
    if (!hit) {
      hit = realpath(cwd).catch(() => resolve(cwd));
      cache.set(cwd, hit);
    }
    return hit;
  };
}
