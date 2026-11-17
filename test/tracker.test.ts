import { appendFileSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_PATH,
  type SessionSource,
  WorktreeTotalsTracker,
} from "../src/tracker.ts";
import type { Worktree } from "../src/worktree.ts";
import { e, Fixture } from "./fixtures.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const min = (n: number) => T0 + n * 60_000;

let fx: Fixture;
let repo: string;
let active: string;
beforeEach(() => {
  fx = new Fixture();
  repo = fx.dir("repo");
  active = fx.folder("repo");
});
afterEach(() => fx.cleanup());

const resolve = async (): Promise<Worktree> => ({
  root: repo,
  lifetimeStart: null,
  kind: "main",
});

/** In-memory SessionSource, optionally backed by a file. */
function source(
  entries: object[],
  file?: string,
  sessionDir = active,
): SessionSource {
  const header = {
    type: "session",
    version: 3,
    id: "live",
    timestamp: new Date(min(0)).toISOString(),
    cwd: repo,
  };
  return {
    getCwd: () => repo,
    getSessionDir: () => sessionDir,
    getSessionFile: () => file,
    getHeader: () => header,
    getEntries: () => entries,
  };
}

describe("WorktreeTotalsTracker", () => {
  it("counts an unsaved (--no-session) live Session", async () => {
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    const live = source([e.assistant(min(5), 2)]);
    const t = await WorktreeTotalsTracker.start(live, fx.agentDir, resolve);

    const cost = await t.refresh(live);
    expect(cost.cost).toBe(3);
    expect(cost.sessions.map((s) => s.path)).toContain(LIVE_PATH);
  });

  it("--no-session still counts saved sessions (empty session dir)", async () => {
    fx.write(fx.folder("anything"), {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    // pi's SessionManager.inMemory reports getSessionDir() === "".
    const live = source([e.assistant(min(5), 2)], undefined, "");
    const t = await WorktreeTotalsTracker.start(live, fx.agentDir, resolve);
    expect((await t.refresh(live)).cost).toBe(3);
  });

  it("live Session stands in for its own file: no duplicates", async () => {
    const entries = [e.assistant(min(1), 1)];
    const file = fx.write(active, { cwd: repo, startedAt: min(0), entries });
    const live = source([...entries], file);
    const t = await WorktreeTotalsTracker.start(live, fx.agentDir, resolve);

    const cost = await t.refresh(live);
    expect(cost.cost).toBe(1);
    expect(cost.sessions).toHaveLength(1);
    expect(cost.sessions[0]!.path).toBe(file);
  });

  it("memory ahead of disk is counted once disk catches up", async () => {
    const first = e.assistant(min(1), 1);
    const file = fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [first],
    });
    const second = e.assistant(min(2), 2);
    const live = source([first, second], file); // not yet on disk
    const t = await WorktreeTotalsTracker.start(live, fx.agentDir, resolve);
    expect((await t.refresh(live)).cost).toBe(3);

    appendFileSync(file, `${JSON.stringify(second)}\n`);
    expect((await t.refresh(live)).cost).toBe(3);
    expect(readFileSync(file, "utf8")).toContain(String(second.id));
  });
});
