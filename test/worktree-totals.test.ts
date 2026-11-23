import { appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOLS_BUCKET } from "../src/session-file.ts";
import { computeWorktreeTotals } from "../src/worktree-totals.ts";
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

const run = (lifetimeStart: Date | null = null, activeDir = active) =>
  computeWorktreeTotals({
    activeSessionDir: activeDir,
    agentDir: fx.agentDir,
    worktreeRoot: repo,
    lifetimeStart,
  });

describe("computeWorktreeTotals", () => {
  it("sums across sessions and counts every billed entry type", async () => {
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [
        e.user(min(1), "hi"),
        e.assistant(min(2), 1),
        e.toolResult(min(3)), // no usage: not billed
        e.toolResult(min(4), 0.5),
        e.usage(min(5), 0.25),
        e.compaction(min(6), 0.125),
        e.branchSummary(min(7), 0.0625),
        e.custom(min(8)), // never billed
      ],
    });
    fx.write(active, {
      cwd: repo,
      startedAt: min(10),
      entries: [e.assistant(min(11), 2, "gpt-5", "openai")],
    });

    const r = await run();
    expect(r.cost).toBeCloseTo(3.9375);
    const costs = [...r.byModel].map(([k, t]) => [k, t.cost]);
    expect(Object.fromEntries(costs)).toEqual({
      "anthropic/claude-sonnet-4-5": 1.25,
      "openai/gpt-5": 2,
      [TOOLS_BUCKET]: 0.6875,
    });
    // Fixture usage is ↑10 ↓5 per billed entry; 6 billed entries.
    expect(r.tokens).toEqual({
      input: 60,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(r.byModel.get("openai/gpt-5")!.tokens.input).toBe(10);
    // Per-session tokens follow the same rules (newest first).
    expect(r.sessions.map((x) => x.tokens.input)).toEqual([10, 50]);
    expect(r.sessions.map((s) => s.cost)).toEqual([2, 1.9375]); // newest first
    expect(r.warnings).toEqual([]);
  });

  it("counts sessions from subfolders, in sibling session folders", async () => {
    const sub = fx.dir("repo", "src", "deep");
    fx.write(fx.folder("repo-src-deep"), {
      cwd: sub,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    expect((await run()).cost).toBe(1);
  });

  it("matches on header cwd, not folder name (e.g. /resume moves)", async () => {
    fx.write(fx.folder("misleading-name"), {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    expect((await run()).cost).toBe(1);
  });

  it("ignores other worktrees, including prefix look-alikes", async () => {
    const other = fx.dir("repo-other");
    fx.write(fx.folder("repo-other"), {
      cwd: other,
      startedAt: min(0),
      entries: [e.assistant(min(1), 5)],
    });
    fx.write(fx.folder("elsewhere"), {
      cwd: "/definitely/elsewhere",
      startedAt: min(0),
      entries: [e.assistant(min(1), 7)],
    });
    expect((await run()).cost).toBe(0);
  });

  it("tokens follow the same dedupe and lifetime rules as cost", async () => {
    const shared = e.assistant(min(1), 1);
    fx.write(active, { cwd: repo, startedAt: min(0), entries: [shared] });
    fx.write(fx.folder("copy"), {
      cwd: repo,
      startedAt: min(0),
      entries: [shared, e.assistant(min(30), 1)],
    });
    const r = await run(new Date(min(20)));
    expect(r.cost).toBe(1);
    expect(r.tokens.input).toBe(10); // only the in-lifetime entry
  });

  it("does not double-count forked/cloned sessions", async () => {
    const shared = [e.user(min(1), "q"), e.assistant(min(2), 1)];
    const parent = fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [...shared, e.assistant(min(3), 0.5)],
    });
    fx.write(active, {
      cwd: repo,
      startedAt: min(10),
      parentSession: parent,
      entries: [...shared, e.assistant(min(11), 2)],
    });

    const r = await run();
    expect(r.cost).toBe(3.5);
    const byLabel = r.sessions.map((s) => [s.startedAt, s.cost]);
    expect(byLabel).toEqual([
      [min(10), 2],
      [min(0), 1.5],
    ]);
  });

  it("excludes inherited spend from a parent outside the worktree", async () => {
    // e.g. `pi --fork <id>` from the main checkout into a new worktree.
    const outside = fx.write(fx.folder("main"), {
      cwd: fx.dir("main"),
      startedAt: min(0),
      entries: [e.assistant(min(1), 9)],
    });
    fx.write(active, {
      cwd: repo,
      startedAt: min(10),
      parentSession: outside,
      entries: [e.assistant(min(1), 9), e.assistant(min(11), 1)],
    });
    expect((await run()).cost).toBe(1);
  });

  it("dedupes an exact copy of a session file", async () => {
    const spec = {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    };
    fx.write(active, spec);
    fx.write(fx.folder("copy"), spec);
    expect((await run()).cost).toBe(1);
  });

  it("counts only entries inside the Worktree Lifetime", async () => {
    // Session from a previous worktree at this path, resumed in the new one.
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 5), e.assistant(min(30), 1)],
    });
    // Older session entirely before the lifetime: listed nowhere.
    fx.write(active, {
      cwd: repo,
      startedAt: min(2),
      entries: [e.assistant(min(3), 8)],
    });

    const r = await run(new Date(min(20)));
    expect(r.cost).toBe(1);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.cost).toBe(1);
  });

  it("lists pre-lifetime Sessions resumed with zero-cost usage", async () => {
    // Copilot review, PR #1: free-model usage adds tokens but no cost.
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 5), e.assistant(min(30), 0, "free")],
    });
    const r = await run(new Date(min(20)));
    expect(r.cost).toBe(0);
    expect(r.tokens.input).toBe(10);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.tokens.input).toBe(10);
  });

  it("counts abandoned /tree branches", async () => {
    const root = e.user(min(1), "q");
    const branchA = { ...e.assistant(min(2), 1), parentId: root.id };
    const branchB = { ...e.assistant(min(3), 2), parentId: root.id };
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [root, branchA, branchB],
    });
    expect((await run()).cost).toBe(3);
  });

  it("works with a custom flat sessionDir", async () => {
    const flat = fx.dir("custom-sessions");
    fx.write(flat, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    fx.write(flat, {
      cwd: "/elsewhere",
      startedAt: min(0),
      entries: [e.assistant(min(1), 4)],
    });
    // Default-layout sessions are not scanned in flat mode (known limit).
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 16)],
    });
    expect((await run(null, flat)).cost).toBe(1);
  });

  it("matches a session recorded under a symlinked cwd", async () => {
    const link = join(fx.base, "repo-link");
    symlinkSync(repo, link);
    fx.write(active, {
      cwd: link,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    expect((await run()).cost).toBe(1);
  });

  it("skips malformed lines and invalid files with warnings", async () => {
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
      rawLines: ["{not json", "[1,2]"],
    });
    writeFileSync(join(active, "garbage.jsonl"), "nope\n");

    const r = await run();
    expect(r.cost).toBe(1);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join("\n")).toMatch(/skipped malformed lines/);
    expect(r.warnings.join("\n")).toMatch(/garbage\.jsonl: not a pi session/);
  });

  it("malformed-line warning is stable as the count grows", async () => {
    // Issue 08: notifications dedupe by message, so it mustn't embed a count.
    const f = fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
      rawLines: ["{bad"],
    });
    const before = (await run()).warnings;
    appendFileSync(f, "{bad again\n");
    expect((await run()).warnings).toEqual(before);
  });

  it("labels sessions by name, else first prompt", async () => {
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.user(min(1), "  fix   the\nbug "), e.assistant(min(2), 1)],
    });
    fx.write(active, {
      cwd: repo,
      startedAt: min(5),
      entries: [
        e.user(min(6), "x".repeat(200)),
        e.name(min(7), "old"),
        e.name(min(8), "Refactor auth"),
      ],
    });
    fx.write(active, { cwd: repo, startedAt: min(9), entries: [] });

    const labels = (await run()).sessions.map((s) => s.label);
    expect(labels).toEqual(["(no prompt)", "Refactor auth", "fix the bug"]);
  });

  it("returns zero when there are no sessions at all", async () => {
    const r = await run(null, join(fx.base, "agent2", "sessions", "--x--"));
    expect(r).toMatchObject({ cost: 0, sessions: [], warnings: [] });
  });
});
