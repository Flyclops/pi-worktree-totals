import {
  appendFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionText } from "../src/session-file.ts";
import { WorktreeTotalsIndex } from "../src/worktree-totals.ts";
import { e, Fixture } from "./fixtures.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const min = (n: number) => T0 + n * 60_000;
const line = (x: object) => `${JSON.stringify(x)}\n`;

let fx: Fixture;
let repo: string;
let active: string;
let index: WorktreeTotalsIndex;

beforeEach(() => {
  fx = new Fixture();
  repo = fx.dir("repo");
  active = fx.folder("repo");
  index = new WorktreeTotalsIndex({
    activeSessionDir: active,
    agentDir: fx.agentDir,
    worktreeRoot: repo,
    lifetimeStart: null,
  });
});
afterEach(() => fx.cleanup());

const session = (cost: number, folder = active, cwd = repo) =>
  fx.write(folder, {
    cwd,
    startedAt: min(0),
    entries: [e.assistant(min(1), cost)],
  });

describe("WorktreeTotalsIndex", () => {
  it("does no file reads when nothing changed", async () => {
    session(1);
    session(2);
    expect((await index.refresh()).cost).toBe(3);
    const before = { ...index.stats };

    expect((await index.refresh()).cost).toBe(3);
    expect(index.stats.fileReads).toBe(before.fileReads);
    expect(index.stats.headerReads).toBe(before.headerReads);
  });

  it("picks up appended entries", async () => {
    const f = session(1);
    await index.refresh();
    appendFileSync(f, line(e.assistant(min(2), 2)));
    expect((await index.refresh()).cost).toBe(3);
  });

  it("never re-checks files from other Worktrees", async () => {
    const other = session(5, fx.folder("other"), fx.dir("other"));
    await index.refresh();
    const before = { ...index.stats };

    appendFileSync(other, line(e.assistant(min(2), 5)));
    expect((await index.refresh()).cost).toBe(0);
    expect(index.stats).toEqual(before);
  });

  it("removes deleted files", async () => {
    session(1);
    const f = session(2);
    await index.refresh();
    rmSync(f);
    expect((await index.refresh()).cost).toBe(1);
  });

  it("finds new files written by another process", async () => {
    session(1);
    await index.refresh();
    session(4, fx.folder("repo-sub"), fx.dir("repo", "sub"));
    expect((await index.refresh()).cost).toBe(5);
  });

  it("waits for a half-written line instead of warning", async () => {
    const f = session(1);
    await index.refresh();
    const full = line(e.assistant(min(2), 2));
    appendFileSync(f, full.slice(0, 20));

    const mid = await index.refresh();
    expect(mid.cost).toBe(1);
    expect(mid.warnings).toEqual([]);

    appendFileSync(f, full.slice(20));
    const done = await index.refresh();
    expect(done.cost).toBe(3);
    expect(done.warnings).toEqual([]);
  });

  it("re-parses fully when the file is rewritten in place", async () => {
    const f = session(1);
    await index.refresh();
    // Simulate a format migration: header changes, same entries plus more.
    const [header, ...rest] = readFileSync(f, "utf8").trimEnd().split("\n");
    const migrated = { ...JSON.parse(header!), version: 4 };
    writeFileSync(
      f,
      [JSON.stringify(migrated), ...rest, JSON.stringify(e.assistant(min(2), 2))]
        .join("\n") + "\n",
    );
    expect((await index.refresh()).cost).toBe(3); // not 1 + 1 + 2
  });

  it("detects a same-size rewrite via the header line", async () => {
    const f = session(1);
    await index.refresh();
    // Same byte length everywhere, so only the header check can tell that
    // earlier content changed (cost 1 → 9, version 3 → 4).
    const text = readFileSync(f, "utf8")
      .replace('"version":3', '"version":4')
      .replace('"total":1}', '"total":9}');
    writeFileSync(f, text);
    expect((await index.refresh()).cost).toBe(9);
  });

  it("re-parses fully when the file shrinks", async () => {
    const f = session(1);
    appendFileSync(f, line(e.assistant(min(2), 2)));
    await index.refresh();
    session(0); // keep the folder non-empty
    writeFileSync(f, readFileSync(f, "utf8").split("\n").slice(0, 2).join("\n") + "\n");
    expect((await index.refresh()).cost).toBe(1);
  });

  it("retries files whose header isn't written yet, without warning", async () => {
    const f = join(active, "pending.jsonl");
    writeFileSync(f, "");
    expect(await index.refresh()).toMatchObject({ cost: 0, warnings: [] });

    writeFileSync(
      f,
      line({
        type: "session",
        version: 3,
        id: "p",
        timestamp: new Date(min(0)).toISOString(),
        cwd: repo,
      }) + line(e.assistant(min(1), 7)),
    );
    expect((await index.refresh()).cost).toBe(7);
  });

  it("keeps warning about invalid files on every refresh", async () => {
    writeFileSync(join(active, "bad.jsonl"), "nope\n");
    expect((await index.refresh()).warnings).toHaveLength(1);
    expect((await index.refresh()).warnings).toHaveLength(1);
  });

  it("coalesces concurrent refreshes", async () => {
    session(1);
    const first = index.refresh();
    const second = index.refresh();
    const third = index.refresh();
    expect(third).toBe(second);
    expect((await first).cost).toBe(1);
    expect((await second).cost).toBe(1);
  });

  it("dedupes extra (live) sessions against files", async () => {
    const shared = e.assistant(min(1), 1);
    fx.write(active, { cwd: repo, startedAt: min(0), entries: [shared] });
    const header = {
      type: "session",
      id: "live",
      timestamp: new Date(min(0)).toISOString(),
      cwd: repo,
    };
    const live = parseSessionText(
      "(live)",
      [header, shared, e.assistant(min(2), 2)]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    )!;
    expect((await index.refresh([live])).cost).toBe(3);
  });

  // Copilot review, PR #1.
  it("merges a live Session with its file when disk is ahead", async () => {
    const first = e.assistant(min(1), 1);
    const f = fx.write(active, { cwd: repo, startedAt: min(0), entries: [first] });
    // Another pi process with the same session open appends to the file;
    // this process's memory doesn't have that entry.
    appendFileSync(f, line(e.assistant(min(2), 2)));
    const header = JSON.parse(readFileSync(f, "utf8").split("\n")[0]!);
    const live = parseSessionText(
      f,
      [header, first].map((x) => JSON.stringify(x)).join("\n"),
    )!;

    const r = await index.refresh([live]);
    expect(r.cost).toBe(3);
    expect(r.sessions).toHaveLength(1);
  });

  it("lets a cleared session name restore the first-prompt label", async () => {
    const f = fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.user(min(1), "first prompt"), e.assistant(min(2), 1)],
    });
    appendFileSync(f, line(e.name(min(3), "Named")));
    expect((await index.refresh()).sessions[0]!.label).toBe("Named");
    appendFileSync(f, line(e.name(min(4), "")));
    expect((await index.refresh()).sessions[0]!.label).toBe("first prompt");
  });

  it("a coalesced refresh uses the latest live snapshot", async () => {
    session(1);
    const liveWith = (cost: number) =>
      parseSessionText(
        "(live)",
        [
          {
            type: "session",
            id: "live",
            timestamp: new Date(min(0)).toISOString(),
            cwd: repo,
          },
          e.assistant(min(5), cost),
        ]
          .map((x) => JSON.stringify(x))
          .join("\n"),
      )!;
    const running = index.refresh();
    const stale = index.refresh([liveWith(10)]);
    const latest = index.refresh([liveWith(20)]);
    expect(latest).toBe(stale); // coalesced
    await running;
    expect((await latest).cost).toBe(21);
  });
});
