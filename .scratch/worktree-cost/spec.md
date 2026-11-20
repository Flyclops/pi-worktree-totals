# Spec: pi-worktree-totals

Status: ready-for-agent

Vocabulary: see `GLOSSARY.md`. Key decision: `docs/adr/0001`.

## Problem

Pi's footer shows Session Cost for the current Session only. A Worktree
usually goes through many Sessions, so its total spend isn't visible anywhere.

## Goal

A pi package with one extension that:

1. Shows the Worktree Totals as a footer status item
   (`wt: ↑1.2M ↓340k $12.345`; R/W hidden for now, Q32), kept fresh
   after every turn, including spend from other pi processes in the same
   Worktree.
2. Provides `/worktree-totals`, which prints the Worktree Totals, one line per
   Session (name or first prompt, date, cost), and totals per model (tokens
   and cost).

## Decisions

| #   | Decision                                                                 |
| --- | ------------------------------------------------------------------------ |
| Q6  | Derive cost from pi session files; no ledger (ADR-0001).                 |
| Q7  | Worktree = `git rev-parse --show-toplevel` of cwd; else cwd.             |
| Q7  | A Session belongs if its header `cwd` is the Worktree or beneath it.     |
| Q8  | Skip Inherited Entries: in a session with `parentSession`, entries older |
|     | than its header; plus a cross-file `id` + `timestamp` dedupe.            |
| Q9  | Main checkouts are Worktrees too; their lifetime has no start bound.     |
| Q10 | Linked worktree lifetime starts at `.git/worktrees/<name>` creation.     |
| Q11 | Filter by each billed entry's own timestamp, not Session start.          |
| Q12 | Use `ctx.ui.setStatus`; never replace the footer. 3-decimal `$`.         |
| Q13 | Re-check changed session files after each turn (stat-gated).             |
| Q14 | Breakdown: per Session + per model. (Tokens: superseded by Q23–Q26.)   |
| Q15 | Scan pi's configured session dir only; ignore subagent/custom dirs.      |
| Q16 | Show nominal cost for everything; no `(sub)` split (no extension API).   |
| Q17 | Record Q6 as ADR-0001 (hard to reverse, surprising, real trade-off). |
| Q18 | Include abandoned `/tree` branches, matching Session Cost.               |
| Q19 | Include the live current Session even with `--no-session`.               |
| Q20 | Ship as a pi package (TypeScript, `pi` key in `package.json`).           |
| Q21 | Pure core tested with Vitest on fixture JSONL; thin manual-tested glue.  |
| Q23 | Token totals too; the pair is called Worktree Totals (Q27).             |
| Q24 | Footer shows tokens and cost.                                            |
| Q25 | Command: tokens in the total and per-model lines. (Sessions: see Q35.)  |
| Q26 | pi's format: `↑in ↓out Rcache-read Wcache-write`, zero kinds omitted.    |
| Q28 | Footer: `wt: ↑… ↓… R… W… $x.xxx`, pi's stats order.                      |
| Q32 | R/W (cache) tokens hidden in footer and report for now; still counted. |
|     | Toggle: `SHOW_CACHE_TOKENS` in `src/format.ts`.                          |
| Q30 | Report = custom session entry + entry renderer: a point-in-time        |
|     | snapshot in the chat, never sent to the model, kept on resume.           |
| Q31 | Skill-started Sessions are labelled `/skill:<name> [args]`.              |
| Q33 | Command `/worktree-totals`; entry type `worktree-totals-report`.       |
| Q34 | Extension/package renamed `pi-worktree-totals`; status key and notify  |
|     | prefix `worktree-totals`.                                                |
| Q35 | Session lines show tokens then cost, column-aligned (trial; user may   |
|     | revert).                                                                 |
| Q29 | Keep status key `worktree-totals`; accept truncation on narrow terminals. |

## Billed entries

These match pi's `getSessionStats()` in `dist/core/agent-session.js`:

- `message` entries with role `assistant`: `message.usage.cost.total`
- `message` entries with role `toolResult` that carry `usage`
- `usage` entries (any `kind`)
- `compaction` and `branch_summary` entries that carry `usage`

## Session discovery

Work out the **scan set** (the folders to scan) from the active Session:

1. `active = ctx.sessionManager.getSessionDir()`, with paths resolved.
   `defaultRoot = join(getAgentDir(), "sessions")`; `getAgentDir` is exported
   by pi.
2. **Default layout**: `dirname(active)` equals `defaultRoot`, and
   `basename(active)` matches `--*--`. Scan every `--*--` subfolder of
   `defaultRoot`. That covers Sessions started in Worktree subfolders and
   Sessions whose cwd moved with `/resume`.
3. **Custom flat layout** (anything else: the `sessionDir` setting, the
   `--session-dir` flag or `PI_CODING_AGENT_SESSION_DIR`): the scan set is
   just `active`, top-level `*.jsonl` files only.
4. An empty `active` (in-memory `--no-session`; pi stores "") uses the
   default layout. A custom `sessionDir` is invisible in that case.
5. In either layout, read each file's header line and keep it if its `cwd`
   is the Worktree root or lies beneath it. Never decode folder names; the
   encoding is lossy.

We deliberately don't copy pi's private folder-name encoding. The layout
check is purely structural, so it keeps working if pi changes the encoding.
The one ambiguity: a custom `sessionDir` that itself looks like a `--*--`
folder under `defaultRoot` gets scanned as the default layout. That's
harmless, because step 4 still filters by header `cwd`; it just scans more
files.

Known limit: Sessions written before you switched to a custom `sessionDir`
are not counted (Q15).

## Performance

- Cold start: O(E), where E = billed entries across all session files in the
  sessions root (headers) plus matching files (bodies).
- Per turn: O(F) `stat` calls for F candidate files, plus re-parsing only the
  files that changed. Session files are append-only, so a later improvement can
  parse from the last byte offset.
- Memory: one dedupe set of entry keys, O(E) for the Worktree.
- Possible bottleneck: a large sessions root (yours has 74 folders). Header
  reads are one line each; benchmark the cold start in issue 03.

## Out of scope (v1)

Subagent session folders, in-memory subagent runs, subscription split, team
rollup, export, a CLI report, a persistent cache.
