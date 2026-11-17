/**
 * Text formatting for the footer status and the /worktree-totals report.
 * Matches pi's own footer and /session styling (spec Q26, Q28).
 */
import type { Totals, WorktreeTotals } from "./aggregate.ts";
import type { TokenTotals } from "./session-file.ts";
import type { Worktree } from "./worktree.ts";

/** Theme colorizer, e.g. `ctx.ui.theme.fg`. Identity in tests. */
export type Paint = (color: "dim" | "accent", text: string) => string;
export interface Style {
  fg: Paint;
  bold: (text: string) => string;
}
export const plain: Style = { fg: (_c, t) => t, bold: (t) => t };

/**
 * Whether to display cache-read (R) and cache-write (W) token totals.
 * They're still gathered and aggregated; this only controls display.
 */
export const SHOW_CACHE_TOKENS = false;

/** Max Session lines in the report before summarising the rest. */
export const SESSION_LINES = 20;

/**
 * Copy of pi's footer `formatTokens` (pi-coding-agent
 * `modes/interactive/components/footer.js`, not exported).
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** A displayed token kind: its mark (↑ ↓ R W) and formatted count. */
type TokenCell = { mark: string; num: string };

/**
 * One cell per displayed token kind, in pi's order; `num` is "" where the
 * kind is zero.
 */
function tokenCells(
  t: TokenTotals,
  showCache = SHOW_CACHE_TOKENS,
): TokenCell[] {
  const cell = (mark: string, n: number) => ({
    mark,
    num: n ? formatTokens(n) : "",
  });
  const cells = [cell("↑", t.input), cell("↓", t.output)];
  if (showCache) cells.push(cell("R", t.cacheRead), cell("W", t.cacheWrite));
  return cells;
}

/**
 * `↑in ↓out Rread Wwrite`, omitting zero kinds, as pi's footer does. R and W
 * appear only when `showCache` is set (default: SHOW_CACHE_TOKENS).
 */
export function formatTokenParts(
  t: TokenTotals,
  showCache = SHOW_CACHE_TOKENS,
): string {
  return tokenCells(t, showCache)
    .filter((c) => c.num !== "")
    .map((c) => c.mark + c.num)
    .join(" ");
}

/**
 * Lay out rows of token totals as table columns, one per kind: each mark in
 * a fixed column and the numbers right-aligned after it, e.g. `↑ 12 ↓4.1k`
 * over `↑160 ↓ 97k`. Zero cells are blank. Kinds that are zero in every row
 * are dropped.
 */
export function tokenColumns(rows: readonly TokenTotals[]): string[] {
  const cells = rows.map((t) => tokenCells(t));
  const kinds = cells[0]?.length ?? 0;
  const widths: number[] = [];
  for (let k = 0; k < kinds; k++) {
    widths.push(Math.max(...cells.map((c) => c[k]!.num.length)));
  }
  return cells.map((c) =>
    c
      .map(({ mark, num }, k) => {
        const w = widths[k]!;
        if (w === 0) return undefined; // kind is zero in every row
        return num ? mark + num.padStart(w) : " ".repeat(mark.length + w);
      })
      .filter((cell) => cell !== undefined)
      .join(" "),
  );
}

export const formatCost = (cost: number) => `$${cost.toFixed(3)}`;

/** Tokens then cost, e.g. `↑1.2M ↓340k $12.345`. */
export function formatTotals(t: Totals, showCache = SHOW_CACHE_TOKENS): string {
  const tokens = formatTokenParts(t.tokens, showCache);
  return tokens ? `${tokens} ${formatCost(t.cost)}` : formatCost(t.cost);
}

/** Prefix for every footer status this extension shows. */
export const STATUS_PREFIX = "wt:";

/** Footer status text: `wt: ↑… ↓… $x.xxx` (plus R/W if shown). */
export function formatStatus(t: Totals, showCache = SHOW_CACHE_TOKENS): string {
  return `${STATUS_PREFIX} ${formatTotals(t, showCache)}`;
}

/** Local `YYYY-MM-DD HH:MM`. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** Max warnings stored in a snapshot. */
export const WARNING_LINES = 10;

/**
 * A point-in-time /worktree-totals report, stored in the session as a custom
 * entry (spec Q30). Plain JSON, so it survives reloads and pi upgrades; it's
 * formatted at render time so it follows the current theme. Bounded size:
 * at most SESSION_LINES sessions and WARNING_LINES warnings are kept.
 */
export interface ReportSnapshot {
  version: 1;
  takenAt: number;
  worktree: { root: string; kind: Worktree["kind"]; lifetimeStart: number | null };
  totals: Totals;
  /** Cost-descending, like pi's /session. */
  byModel: [string, Totals][];
  sessionCount: number;
  /** Newest SESSION_LINES sessions. */
  sessions: {
    label: string;
    startedAt: number;
    cost: number;
    /** Absent in snapshots taken before per-session tokens existed. */
    tokens?: TokenTotals;
  }[];
  /** Cost of the sessions beyond SESSION_LINES. */
  olderCost: number;
  /** Tokens of the sessions beyond SESSION_LINES. */
  olderTokens?: TokenTotals;
  warningCount: number;
  warnings: string[];
}

export function toSnapshot(
  wt: Worktree,
  t: WorktreeTotals,
  takenAt: number,
): ReportSnapshot {
  const shown = t.sessions.slice(0, SESSION_LINES);
  const older = t.sessions.slice(SESSION_LINES);
  return {
    version: 1,
    takenAt,
    worktree: {
      root: wt.root,
      kind: wt.kind,
      lifetimeStart: wt.lifetimeStart?.getTime() ?? null,
    },
    totals: { cost: t.cost, tokens: { ...t.tokens } },
    byModel: [...t.byModel].sort((a, b) => b[1].cost - a[1].cost),
    sessionCount: t.sessions.length,
    sessions: shown.map(({ label, startedAt, cost, tokens }) => ({
      label,
      startedAt,
      cost,
      tokens: { ...tokens },
    })),
    olderCost: older.reduce((sum, l) => sum + l.cost, 0),
    olderTokens: sumTokens(older.map((l) => l.tokens)),
    warningCount: t.warnings.length,
    warnings: t.warnings.slice(0, WARNING_LINES),
  };
}

function sumTokens(all: readonly TokenTotals[]): TokenTotals {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const x of all) {
    t.input += x.input;
    t.output += x.output;
    t.cacheRead += x.cacheRead;
    t.cacheWrite += x.cacheWrite;
  }
  return t;
}

const NO_TOKENS: TokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** Narrow unknown entry data (e.g. from an older version) to a snapshot. */
export function isSnapshot(data: unknown): data is ReportSnapshot {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { version?: unknown }).version === 1
  );
}

/**
 * The /worktree-totals report: Worktree, Worktree Totals, per-model totals,
 * and the newest Sessions, as of when the snapshot was taken.
 */
export function formatReport(r: ReportSnapshot, s: Style = plain): string {
  const dim = (t: string) => s.fg("dim", t);
  const out: string[] = [
    `${s.bold("Worktree Totals")} ${dim(`as of ${formatDate(r.takenAt)}`)}`,
    "",
  ];

  const { worktree: wt } = r;
  const kind =
    wt.kind === "linked" && wt.lifetimeStart !== null
      ? `linked worktree, since ${formatDate(wt.lifetimeStart)}`
      : wt.kind === "none"
        ? "not a git repository, all time"
        : "main checkout, all time";
  out.push(`${dim("Worktree:")} ${wt.root} ${dim(`(${kind})`)}`);
  out.push(`${dim("Total:")} ${formatTotals(r.totals)}`);

  if (r.byModel.length > 0) {
    out.push("", s.bold("By model"));
    for (const [key, t] of r.byModel) {
      out.push(`  ${dim(`${key}:`)} ${formatTotals(t)}`);
    }
  }

  if (r.sessionCount > 0) {
    out.push("", s.bold(`Sessions (${r.sessionCount})`));
    const older = r.sessionCount - r.sessions.length;
    // Tokens then cost, as in the total and per-model lines (spec Q35).
    // Token kinds and costs are column-aligned across session rows and the
    // "older" summary row.
    const rows = r.sessions.map((l) => ({
      tokens: l.tokens ?? NO_TOKENS,
      cost: formatCost(l.cost),
    }));
    if (older > 0) {
      rows.push({
        tokens: r.olderTokens ?? NO_TOKENS,
        cost: formatCost(r.olderCost),
      });
    }
    const tokens = tokenColumns(rows.map((x) => x.tokens));
    const costWidth = Math.max(...rows.map((x) => x.cost.length));
    const figures = rows.map((x, i) => {
      const cost = x.cost.padStart(costWidth);
      return tokens[i] ? `${tokens[i]}  ${cost}` : cost;
    });

    r.sessions.forEach((line, i) => {
      out.push(
        `  ${dim(formatDate(line.startedAt))}  ${figures[i]}  ${line.label}`,
      );
    });
    if (older > 0) {
      const pad = " ".repeat(formatDate(0).length);
      out.push(
        dim(`  ${pad}  ${figures[rows.length - 1]}  … ${older} older session(s)`),
      );
    }
  }

  if (r.warningCount > 0) {
    out.push("", dim(`${r.warningCount} warning(s):`));
    for (const w of r.warnings) out.push(dim(`  ${w}`));
    if (r.warningCount > r.warnings.length) {
      out.push(dim(`  … ${r.warningCount - r.warnings.length} more`));
    }
  }
  return out.join("\n");
}
