/**
 * Parity with pi's own accounting. For a session without forks or lifetime
 * bounds, our per-entry billing must give the same total and per-model
 * breakdown as pi's getUsageCostBreakdown (what the footer and /session use).
 * If pi changes its billing rules, this test fails.
 */
import { describe, expect, it } from "vitest";
// Not a public export, so import by file path from the pinned devDependency.
import { getUsageCostBreakdown } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/usage-totals.js";
import { parseSessionText } from "../src/session-file.ts";
import { e } from "./fixtures.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");

/** pi keys assistant usage by responseModel when present. */
function withResponseModel(entry: Record<string, unknown>) {
  const message = entry.message as Record<string, unknown>;
  return { ...entry, message: { ...message, responseModel: "gpt-5-2026" } };
}

describe("parity with pi's getUsageCostBreakdown", () => {
  it("same cost, tokens and model keys", () => {
    const entries = [
      e.user(T0 + 1, "hi"),
      e.assistant(T0 + 2, 1.5),
      withResponseModel(e.assistant(T0 + 3, 0.75, "gpt-5", "openai")),
      e.toolResult(T0 + 4, 0.25),
      e.toolResult(T0 + 5),
      e.usage(T0 + 6, 0.125),
      e.compaction(T0 + 7, 0.0625),
      e.branchSummary(T0 + 8, 0.03125),
      e.custom(T0 + 9),
    ];
    const header = {
      type: "session",
      version: 3,
      id: "s",
      timestamp: new Date(T0).toISOString(),
      cwd: "/r",
    };
    const text = [header, ...entries].map((x) => JSON.stringify(x)).join("\n");

    const ours = parseSessionText("/f.jsonl", text)!;
    const oursByModel: Record<string, { cost: number; tokens: number }> = {};
    for (const b of ours.billed) {
      const m = (oursByModel[b.model] ??= { cost: 0, tokens: 0 });
      m.cost += b.cost;
      const t = b.tokens;
      m.tokens += t.input + t.output + t.cacheRead + t.cacheWrite;
    }

    const theirs = Object.fromEntries(
      getUsageCostBreakdown(entries as never).map((x) => [
        x.key,
        { cost: x.cost, tokens: x.tokens },
      ]),
    );
    expect(oursByModel).toEqual(theirs);
  });
});
