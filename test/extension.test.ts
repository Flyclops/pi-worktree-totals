import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worktreeCost, {
  COMMAND,
  createExtension,
  REPORT_ENTRY,
} from "../src/extension.ts";
import type { ReportSnapshot } from "../src/format.ts";
import { WorktreeTotalsTracker } from "../src/tracker.ts";
import type { Worktree } from "../src/worktree.ts";
import { e, Fixture } from "./fixtures.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const min = (n: number) => T0 + n * 60_000;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type Command = { handler: (args: string, ctx: unknown) => Promise<void> };
type Renderer = (entry: unknown, opts: unknown, theme: unknown) => unknown;

/** Fake pi that records handlers so tests can fire events. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const renderers = new Map<string, Renderer>();
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
    registerCommand: (name: string, c: Command) => commands.set(name, c),
    registerEntryRenderer: (type: string, r: Renderer) =>
      renderers.set(type, r),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
  } as unknown as ExtensionAPI;
  const fire = (name: string, ctx: ExtensionContext) =>
    (handlers.get(name) ?? []).forEach((h) => h({}, ctx));
  return { pi, fire, handlers, commands, renderers, appended };
}

/** Fake theme that tags colors, so tests can see styling. */
const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
};

let fx: Fixture;
let repo: string;
let active: string;
beforeEach(() => {
  fx = new Fixture();
  repo = fx.dir("repo");
  active = fx.folder("repo");
});
afterEach(() => fx.cleanup());

function fakeCtx(hasUI = true) {
  const status = vi.fn();
  const notify = vi.fn();
  const entries: object[] = [];
  const ctx = {
    hasUI,
    ui: {
      setStatus: status,
      notify,
      theme: fakeTheme,
    },
    sessionManager: {
      getCwd: () => repo,
      getSessionDir: () => active,
      getSessionFile: () => undefined,
      getHeader: () => ({
        type: "session",
        id: "live",
        timestamp: new Date(min(0)).toISOString(),
        cwd: repo,
      }),
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
  const lastStatus = () => status.mock.calls.at(-1)?.[1];
  return { ctx, status, notify, entries, lastStatus };
}

const resolve = async (): Promise<Worktree> => ({
  root: repo,
  lifetimeStart: null,
  kind: "main",
});

function loadAll() {
  const fake = fakePi();
  createExtension({
    agentDir: () => fx.agentDir,
    startTracker: (s, a) => WorktreeTotalsTracker.start(s, a, resolve),
  })(fake.pi);
  return fake;
}
const load = () => loadAll().fire;

describe("extension", () => {
  it("default export loads without calling pi beyond registering", () => {
    const { pi, handlers } = fakePi();
    expect(() => worktreeCost(pi)).not.toThrow();
    expect([...handlers.keys()]).toContain("session_start");
  });

  it("shows the Worktree Cost on start and after each turn", async () => {
    fx.write(active, {
      cwd: repo,
      startedAt: min(0),
      entries: [e.assistant(min(1), 1)],
    });
    const fire = load();
    const { ctx, entries, lastStatus } = fakeCtx();

    fire("session_start", ctx);
    expect(lastStatus()).toBe("<dim>wt: …");
    await vi.waitFor(() => expect(lastStatus()).toBe("<dim>wt: ↑10 ↓5 $1.000"));

    entries.push(e.assistant(min(2), 0.5));
    fire("turn_end", ctx);
    await vi.waitFor(() => expect(lastStatus()).toBe("<dim>wt: ↑20 ↓10 $1.500"));
  });

  it("does nothing without a UI", async () => {
    const fire = load();
    const { ctx, status } = fakeCtx(false);
    fire("session_start", ctx);
    fire("turn_end", ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(status).not.toHaveBeenCalled();
  });

  it("clears on shutdown and ignores late results", async () => {
    const fire = load();
    const { ctx, status, lastStatus } = fakeCtx();
    fire("session_start", ctx);
    fire("session_shutdown", ctx); // before the first refresh resolves
    expect(lastStatus()).toBeUndefined();
    const calls = status.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(status.mock.calls.length).toBe(calls);
  });

  it("reports failures once, with a placeholder status", async () => {
    const { pi, fire } = fakePi();
    createExtension({
      agentDir: () => fx.agentDir,
      startTracker: async () => {
        throw new Error("git exploded");
      },
    })(pi);
    const { ctx, notify, lastStatus } = fakeCtx();
    fire("session_start", ctx);
    await vi.waitFor(() => expect(lastStatus()).toBe("<dim>wt: $?"));
    fire("turn_end", ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([
      "worktree-totals: git exploded",
      "error",
    ]);
  });

  it("reports each warning once", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${active}/bad.jsonl`, "nope\n");
    const fire = load();
    const { ctx, notify, lastStatus } = fakeCtx();
    fire("session_start", ctx);
    await vi.waitFor(() => expect(lastStatus()).toBe("<dim>wt: $0.000"));
    fire("turn_end", ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toBe("warning");
  });

  describe("/worktree-totals", () => {
    it("registers under the documented name", () => {
      expect(COMMAND).toBe("worktree-totals");
      expect(loadAll().commands.has("worktree-totals")).toBe(true);
    });

    it("appends a report snapshot and refreshes the footer", async () => {
      fx.write(active, {
        cwd: repo,
        startedAt: min(0),
        entries: [e.user(min(1), "first prompt"), e.assistant(min(2), 2)],
      });
      const { fire, commands, appended } = loadAll();
      const { ctx, lastStatus } = fakeCtx();
      fire("session_start", ctx);

      await commands.get(COMMAND)!.handler("", ctx);
      expect(appended).toHaveLength(1);
      expect(appended[0]!.type).toBe(REPORT_ENTRY);
      const snap = appended[0]!.data as ReportSnapshot;
      expect(snap.totals.cost).toBe(2);
      expect(snap.sessions.map((x) => x.label)).toContain("first prompt");
      expect(lastStatus()).toBe("<dim>wt: ↑10 ↓5 $2.000");
    });

    it("works without a prior session_start (no UI)", async () => {
      const { commands, appended } = loadAll();
      const { ctx, status } = fakeCtx(false);
      await commands.get(COMMAND)!.handler("", ctx);
      expect(appended).toHaveLength(1);
      expect(status).not.toHaveBeenCalled();
    });

    it("propagates failures to pi", async () => {
      const { pi, commands } = fakePi();
      createExtension({
        agentDir: () => fx.agentDir,
        startTracker: async () => {
          throw new Error("git exploded");
        },
      })(pi);
      const { ctx } = fakeCtx();
      await expect(
        commands.get(COMMAND)!.handler("", ctx),
      ).rejects.toThrow("git exploded");
    });

    it("renders snapshots with the theme, and ignores unknown data", async () => {
      const { commands, appended, renderers } = loadAll();
      const { ctx } = fakeCtx();
      await commands.get(COMMAND)!.handler("", ctx);
      const render = renderers.get(REPORT_ENTRY)!;

      const box = render(
        { type: "custom", customType: REPORT_ENTRY, data: appended[0]!.data },
        { expanded: false },
        fakeTheme,
      ) as { render(width: number): string[] };
      const text = box.render(100).join("\n");
      expect(text).toContain("*Worktree Totals*");
      expect(text).toContain("<dim>Total:");

      expect(
        render({ data: { version: 99 } }, { expanded: false }, fakeTheme),
      ).toBeUndefined();
    });
  });
});
