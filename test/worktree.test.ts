import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  folderCreationTime,
  resolveWorktree,
  WorktreeResolutionError,
} from "../src/worktree.ts";

/** Isolate test git calls from the user's global/system config. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let base: string;
let repo: string;

beforeAll(() => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var).
  base = realpathSync(mkdtempSync(join(tmpdir(), "pwc-wt-")));
  repo = join(base, "repo");
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveWorktree", () => {
  it("main checkout: root is top level, no lifetime bound", async () => {
    const wt = await resolveWorktree(repo);
    expect(wt).toEqual({ root: repo, lifetimeStart: null, kind: "main" });
  });

  it("subfolder cwd resolves to the top level", async () => {
    const wt = await resolveWorktree(join(repo, "src", "deep"));
    expect(wt.root).toBe(repo);
  });

  it("non-git folder: root is the folder itself", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    const wt = await resolveWorktree(plain);
    expect(wt).toEqual({ root: plain, lifetimeStart: null, kind: "none" });
  });

  it("symlinked cwd resolves to the canonical root", async () => {
    const link = join(base, "link-to-repo");
    execFileSync("ln", ["-s", repo, link]);
    expect((await resolveWorktree(link)).root).toBe(repo);
  });

  it("linked worktree: lifetime starts at admin folder creation", async () => {
    const before = Date.now();
    const path = join(base, "wt-a");
    git(repo, "worktree", "add", "-q", path);
    const wt = await resolveWorktree(path);

    expect(wt.kind).toBe("linked");
    expect(wt.root).toBe(path);
    const admin = await stat(join(repo, ".git", "worktrees", "wt-a"));
    expect(wt.lifetimeStart?.getTime()).toBe(Math.trunc(admin.birthtimeMs));
    expect(wt.lifetimeStart!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("worktree recreated at the same path gets a later lifetime", async () => {
    const path = join(base, "wt-b");
    git(repo, "worktree", "add", "-q", path);
    const first = (await resolveWorktree(path)).lifetimeStart!;

    await sleep(30);
    git(repo, "worktree", "remove", path);
    git(repo, "worktree", "add", "-q", path);
    const second = (await resolveWorktree(path)).lifetimeStart!;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("propagates git failures other than 'not a git repository'", async () => {
    const failing = async () => {
      throw Object.assign(new Error("boom"), { stderr: "fatal: other" });
    };
    await expect(resolveWorktree(repo, failing)).rejects.toBeInstanceOf(
      WorktreeResolutionError,
    );
  });

  it.each([
    [
      { stderr: "fatal: detected dubious ownership in repository at '/r'\nTo add an exception…" },
      "git rev-parse failed in REPO: fatal: detected dubious ownership in repository at '/r'",
    ],
    [{ code: "ENOENT", stderr: "" }, "git rev-parse failed in REPO: git not found"],
    [
      { killed: true, signal: "SIGTERM", stderr: "" },
      "git rev-parse failed in REPO: timed out after 5s",
    ],
    [{ stderr: "" }, "git rev-parse failed in REPO: boom"],
  ])("includes git's reason in the error (%o)", async (fields, want) => {
    const failing = async () => {
      throw Object.assign(new Error("boom"), fields);
    };
    await expect(resolveWorktree(repo, failing)).rejects.toThrow(
      want.replace("REPO", repo),
    );
  });

  it("rejects malformed git output", async () => {
    await expect(
      resolveWorktree(repo, async () => "only-one-line\n"),
    ).rejects.toBeInstanceOf(WorktreeResolutionError);
  });
});

describe("folderCreationTime", () => {
  it("falls back to earliest mtime when birthtime is unavailable", async () => {
    const dir = join(base, "no-birthtime");
    mkdirSync(dir);
    const mtimes: Record<string, number> = {
      [dir]: 5_000,
      [join(dir, "commondir")]: 1_000,
      [join(dir, "HEAD")]: 9_000,
    };
    execFileSync("touch", [join(dir, "commondir"), join(dir, "HEAD")]);
    const fakeStat = async (p: string) => ({
      birthtimeMs: 0,
      mtimeMs: mtimes[p]!,
    });

    const t = await folderCreationTime(dir, fakeStat);
    expect(t.getTime()).toBe(1_000);
  });
});
