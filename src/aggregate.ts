/**
 * Turn parsed Sessions into Worktree Totals. Pure: no I/O.
 *
 * Rules (spec Q8, Q11, Q18, Q23):
 * - Each billed entry counts once across all files (id+timestamp dedupe).
 *   Sessions are processed oldest-first, so an entry is credited to the
 *   Session that first recorded it.
 * - Only entries at or after the Worktree Lifetime start count.
 * - Every entry in a file counts, including abandoned /tree branches.
 * - Cost and tokens come from the same entries, so they always agree.
 *
 * Cost: O(E log S) for E billed entries and S sessions (the sort), plus an
 * O(E) dedupe set.
 */
import type { ParsedSession, TokenTotals } from "./session-file.ts";

/** Cost plus token totals for some set of billed entries. */
export interface Totals {
  cost: number;
  tokens: TokenTotals;
}

export interface SessionLine {
  path: string;
  label: string;
  startedAt: number;
  /** This Session's own spend counted toward the Worktree Cost. */
  cost: number;
  /** This Session's own tokens, counted by the same rules as `cost`. */
  tokens: TokenTotals;
}

export interface WorktreeTotals extends Totals {
  /** Newest first. */
  sessions: SessionLine[];
  /** Breakdown key → totals, keys as in pi (`provider/model`). */
  byModel: Map<string, Totals>;
  /** Non-fatal problems, suitable for display. */
  warnings: string[];
}

export function emptyTotals(): Totals {
  return {
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function add(into: Totals, cost: number, t: TokenTotals): void {
  into.cost += cost;
  into.tokens.input += t.input;
  into.tokens.output += t.output;
  into.tokens.cacheRead += t.cacheRead;
  into.tokens.cacheWrite += t.cacheWrite;
}

export function aggregate(
  sessions: readonly ParsedSession[],
  lifetimeStart: Date | null,
  warnings: string[] = [],
): WorktreeTotals {
  const since = lifetimeStart?.getTime() ?? -Infinity;
  const ordered = [...sessions].sort(
    (a, b) =>
      a.header.startedAt - b.header.startedAt || a.path.localeCompare(b.path),
  );

  const seen = new Set<string>();
  const byModel = new Map<string, Totals>();
  const lines: SessionLine[] = [];
  const total = emptyTotals();

  for (const s of ordered) {
    const own = emptyTotals();
    let counted = 0;
    for (const e of s.billed) {
      if (e.at < since || seen.has(e.key)) continue;
      seen.add(e.key);
      counted++;
      add(own, e.cost, e.tokens);
      add(total, e.cost, e.tokens);
      let m = byModel.get(e.model);
      if (!m) byModel.set(e.model, (m = emptyTotals()));
      add(m, e.cost, e.tokens);
    }
    if (s.malformedLines > 0) {
      warnings.push(`${s.path}: skipped ${s.malformedLines} malformed line(s)`);
    }
    // Leave out Sessions that belong only to a previous Worktree Lifetime.
    // Any counted entry keeps the Session, even at zero cost (free models),
    // so session lines always add up to the totals.
    if (counted > 0 || s.header.startedAt >= since) {
      lines.push({
        path: s.path,
        label: s.label,
        startedAt: s.header.startedAt,
        cost: own.cost,
        tokens: own.tokens,
      });
    }
  }

  lines.sort((a, b) => b.startedAt - a.startedAt);
  return { ...total, sessions: lines, byModel, warnings };
}
