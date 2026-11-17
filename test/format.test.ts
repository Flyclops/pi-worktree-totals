import { describe, expect, it } from "vitest";
import type { WorktreeTotals } from "../src/aggregate.ts";
import {
  formatReport,
  formatStatus,
  formatTokenParts,
  formatTokens,
  SESSION_LINES,
  SHOW_CACHE_TOKENS,
  isSnapshot,
  toSnapshot,
  WARNING_LINES,
} from "../src/format.ts";
// pi's own formatter, to pin our copy against it.
import { formatTokens as piFormatTokens } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";

const tokens = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe("formatTokens", () => {
  it.each([0, 999, 1000, 9999, 10_000, 999_499, 1_000_000, 9_999_999, 12e6])(
    "matches pi for %d",
    (n) => expect(formatTokens(n)).toBe(piFormatTokens(n)),
  );
});

describe("formatStatus", () => {
  const all = { cost: 12.3456, tokens: tokens(1200, 340_000, 5.6e6, 200_000) };

  it("hides cache tokens by default", () => {
    expect(SHOW_CACHE_TOKENS).toBe(false);
    expect(formatStatus(all)).toBe("wt: ↑1.2k ↓340k $12.346");
  });

  it("uses pi's footer order and omits zero kinds", () => {
    expect(formatStatus(all, true)).toBe("wt: ↑1.2k ↓340k R5.6M W200k $12.346");
    expect(formatStatus({ cost: 1, tokens: tokens(0, 5) })).toBe(
      "wt: ↓5 $1.000",
    );
  });

  it("falls back to cost alone with no tokens", () => {
    expect(formatStatus({ cost: 0, tokens: tokens() })).toBe("wt: $0.000");
    expect(formatTokenParts(tokens())).toBe("");
  });
});

describe("formatReport", () => {
  const base: WorktreeTotals = {
    cost: 3,
    tokens: tokens(30, 15),
    byModel: new Map([
      ["cheap/model", { cost: 1, tokens: tokens(10, 5) }],
      ["dear/model", { cost: 2, tokens: tokens(20, 10) }],
    ]),
    sessions: [
      {
        path: "/b",
        label: "Second",
        startedAt: Date.UTC(2026, 0, 2),
        cost: 2,
        tokens: tokens(20, 10),
      },
      {
        path: "/a",
        label: "First",
        startedAt: Date.UTC(2026, 0, 1),
        cost: 1,
        tokens: tokens(10, 5),
      },
    ],
    warnings: [],
  };
  const wt = { root: "/repo", lifetimeStart: null, kind: "main" as const };
  const AT = new Date(2026, 10, 16, 20, 30).getTime();

  it("lists totals, models by cost, and sessions", () => {
    const text = formatReport(toSnapshot(wt, base, AT));
    expect(text).toContain("Worktree Totals as of 2026-11-16 20:30");
    expect(text).toContain("Worktree: /repo (main checkout, all time)");
    expect(text).toContain("Total: ↑30 ↓15 $3.000");
    expect(text.indexOf("dear/model")).toBeLessThan(text.indexOf("cheap/model"));
    expect(text).toMatch(/↑20 ↓10 {2}\$2\.000 {2}Second/);
    expect(text).not.toContain("warning");
  });

  it("summarises sessions beyond the limit", () => {
    const sessions = Array.from({ length: SESSION_LINES + 3 }, (_, i) => ({
      path: `/${i}`,
      label: `s${i}`,
      startedAt: i,
      cost: 1,
      tokens: tokens(100, 1),
    }));
    const text = formatReport(toSnapshot(wt, { ...base, sessions }, AT));
    expect(text).toContain(`Sessions (${SESSION_LINES + 3})`);
    expect(text).toMatch(/↑300 ↓3 {2}\$3\.000 {2}… 3 older session\(s\)/);
  });

  it("describes linked worktrees and shows warnings", () => {
    const linked = {
      root: "/wt",
      lifetimeStart: new Date(2026, 10, 16, 13, 48),
      kind: "linked" as const,
    };
    const text = formatReport(toSnapshot(linked, { ...base, warnings: ["x: bad"] }, AT));
    expect(text).toContain("(linked worktree, since 2026-11-16 13:48)");
    expect(text).toContain("1 warning(s):\n  x: bad");
  });

  it("aligns session token and cost columns", () => {
    const row = (input: number, output: number, cost: number, label: string) => ({
      path: `/${label}`,
      label,
      startedAt: 0,
      cost,
      tokens: tokens(input, output),
    });
    const sessions = [
      row(12, 4100, 0.019, "a"),
      row(8, 380, 0.006, "b"),
      row(160, 97_000, 9.157, "c"),
      row(0, 0, 0, "d"),
    ];
    const lines = formatReport(toSnapshot(wt, { ...base, sessions }, AT))
      .split("\n")
      .filter((l) => / [abcd]$/.test(l));
    const col = (needle: string) => lines.map((l) => l.indexOf(needle));
    // Each "↓" and the end of each cost sit in the same column.
    expect(new Set(col("↓").filter((i) => i >= 0)).size).toBe(1);
    expect(new Set(lines.map((l) => l.lastIndexOf(" ") - 1)).size).toBe(1);
    expect(lines[3]).toMatch(/ {2}\$0\.000 {2}d$/); // zero tokens: blanks
  });

  it("renders old snapshots without per-session tokens", () => {
    const snap = toSnapshot(wt, base, AT);
    for (const x of snap.sessions) delete x.tokens;
    expect(formatReport(snap)).toMatch(/\$2\.000 {2}Second/);
  });

  it("caps stored warnings", () => {
    const warnings = Array.from({ length: WARNING_LINES + 2 }, (_, i) => `w${i}`);
    const snap = toSnapshot(wt, { ...base, warnings }, AT);
    expect(snap.warnings).toHaveLength(WARNING_LINES);
    expect(formatReport(snap)).toContain("… 2 more");
  });

  it("survives a JSON round trip (as stored in the session)", () => {
    const snap = toSnapshot(wt, base, AT);
    const back: unknown = JSON.parse(JSON.stringify(snap));
    expect(isSnapshot(back)).toBe(true);
    expect(formatReport(back as typeof snap)).toBe(formatReport(snap));
  });

  it("rejects unknown snapshot data", () => {
    expect(isSnapshot(undefined)).toBe(false);
    expect(isSnapshot({ version: 2 })).toBe(false);
  });
});
