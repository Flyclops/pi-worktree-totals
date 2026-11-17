import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectLayout,
  isWithin,
  listSessionFiles,
} from "../src/discovery.ts";
import { Fixture } from "./fixtures.ts";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

describe("detectLayout", () => {
  it("default: per-cwd folder directly under <agentDir>/sessions", () => {
    const active = join(fx.sessionsRoot, "--Users-x-repo--");
    expect(detectLayout(active, fx.agentDir)).toEqual({
      kind: "default",
      root: fx.sessionsRoot,
    });
  });

  it("default even when the folder name isn't the cwd's encoding", () => {
    // We never re-derive pi's private encoding, so a drift can't break us.
    const active = join(fx.sessionsRoot, "--some-other-encoding--");
    expect(detectLayout(active, fx.agentDir).kind).toBe("default");
  });

  it("default for an in-memory (--no-session) session's empty dir", () => {
    expect(detectLayout("", fx.agentDir)).toEqual({
      kind: "default",
      root: fx.sessionsRoot,
    });
  });

  it("flat: a custom sessionDir elsewhere", () => {
    const active = join(fx.base, "custom-sessions");
    expect(detectLayout(active, fx.agentDir)).toEqual({
      kind: "flat",
      dir: active,
    });
  });

  it("flat: the sessions root itself, or a non --*-- child", () => {
    expect(detectLayout(fx.sessionsRoot, fx.agentDir).kind).toBe("flat");
    const odd = join(fx.sessionsRoot, "plain");
    expect(detectLayout(odd, fx.agentDir).kind).toBe("flat");
  });
});

describe("listSessionFiles", () => {
  it("default layout scans every --*-- sibling, nothing else", async () => {
    const a = fx.folder("a");
    const b = fx.folder("b");
    writeFileSync(join(a, "1.jsonl"), "");
    writeFileSync(join(b, "2.jsonl"), "");
    writeFileSync(join(b, "notes.txt"), "");
    mkdirSync(join(fx.sessionsRoot, "not-a-cwd-folder"));
    writeFileSync(join(fx.sessionsRoot, "not-a-cwd-folder", "3.jsonl"), "");
    writeFileSync(join(fx.sessionsRoot, ".pi-subagents-fork-cleanup"), "");

    const files = await listSessionFiles({
      kind: "default",
      root: fx.sessionsRoot,
    });
    expect(files.sort()).toEqual([join(a, "1.jsonl"), join(b, "2.jsonl")]);
  });

  it("flat layout scans only top-level jsonl", async () => {
    const dir = fx.dir("flat");
    writeFileSync(join(dir, "1.jsonl"), "");
    fx.dir("flat", "--nested--");
    writeFileSync(join(dir, "--nested--", "2.jsonl"), "");

    expect(await listSessionFiles({ kind: "flat", dir })).toEqual([
      join(dir, "1.jsonl"),
    ]);
  });

  it("missing folder means no sessions", async () => {
    const dir = join(fx.base, "nope");
    expect(await listSessionFiles({ kind: "flat", dir })).toEqual([]);
    expect(await listSessionFiles({ kind: "default", root: dir })).toEqual([]);
  });
});

describe("isWithin", () => {
  it.each([
    ["/repo", "/repo", true],
    ["/repo/src/x", "/repo", true],
    ["/repo-other", "/repo", false],
    ["/re", "/repo", false],
    ["/anything", "/", true],
  ])("%s within %s → %s", (p, root, want) => {
    expect(isWithin(p, root)).toBe(want);
  });
});
