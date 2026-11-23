# pi-worktree-totals

A [pi](https://pi.dev) extension that shows how much model spend a git
worktree has accumulated across **every** pi session run inside it, not just
the current one.

pi's footer shows the current session's cost. A single worktree usually goes
through many sessions; this adds them up.

```
wt: ↑414 ↓168k $14.470
```

## Install

```bash
pi install git:github.com/Flyclops/pi-worktree-totals
```

It's distributed from GitHub only; it isn't published to npm.

Or try it for one run without installing:

```bash
pi -e git:github.com/Flyclops/pi-worktree-totals
```

For development, from a checkout:

```bash
npm install
pi -e .
```

## Usage

### Footer

The footer status line shows the Worktree Totals: input and output tokens,
then cost, in pi's own format. It updates after every turn, compaction and
`/tree` branch summary, and picks up spend from other pi processes in the same
worktree (e.g. a second pane) on your next turn.

### `/worktree-totals`

Adds a report to the chat: the worktree, its totals, a per-model breakdown,
and the newest sessions with their tokens and cost.

```
Worktree Totals as of 2026-11-16 21:33

Worktree: /code/app-feature-x (linked worktree, since 2026-11-16 13:48)
Total: ↑414 ↓168k $14.470

By model
  anthropic/claude-opus-5-5: ↑406 ↓168k $14.465
  anthropic/claude-haiku-5-5: ↑8 ↓380 $0.005

Sessions (3)
  2026-11-16 21:20  ↑  4 ↓ 199   $0.007  hello claude, how's living
  2026-11-16 14:39  ↑ 20 ↓1.9k   $0.104  why is auth failing?
  2026-11-16 13:48  ↑390 ↓166k  $14.359  /skill:grill-with-docs
```

The report is a point-in-time snapshot stored in the session. It's never sent
to the model, and it reappears when you resume the session.

## What counts

Vocabulary is defined in [GLOSSARY.md](GLOSSARY.md).

- **Worktree:** the top level of the git working tree pi was started in
  (linked worktree or main checkout). Outside git, the start directory.
- **Sessions:** every pi session whose working directory is the worktree or
  anything beneath it, including sessions started in subfolders.
- **Worktree Lifetime:** for a linked worktree, only spend since git created
  it. A worktree deleted and recreated at the same path starts from zero.
  Main checkouts count all time.
- **Billed entries:** the same entries pi's own session cost counts:
  assistant messages, tool results with usage, cache warming, compaction and
  branch summaries. Spend on abandoned `/tree` branches counts, as it does in
  pi.
- **Forks and clones:** history copied from a parent session is counted once,
  even when the parent lives in a different worktree.
- **`--no-session`:** the live, unsaved session is included.

The numbers come straight from pi's session files
(see [ADR-0001](docs/adr/0001-derive-cost-from-pi-sessions.md)), so they
always agree with pi. Nothing is stored in your worktree.

## Known limits

- **Deleted sessions drop out.** Session files are the source of truth;
  delete one and its spend leaves the total.
- **Subagent runs aren't counted.** pi-subagents stores runs in nested
  folders, which aren't scanned.
- **Custom session folders:** with a custom `sessionDir`, only that folder is
  scanned. With `--no-session`, the default folder is assumed.
- **No subscription split.** Cost is pi's token-rate cost for all usage, with
  no `(sub)` marker.
- **Cache tokens are hidden.** Cache-read (R) and cache-write (W) tokens are
  counted but not displayed (`SHOW_CACHE_TOKENS` in `src/format.ts`). A
  session's cost can be mostly cache writes, so cost may look high next to
  its ↑/↓ counts.
- **Snapshots and sharing.** A `/worktree-totals` snapshot is saved in the
  current session and includes the first prompts of up to 20 other sessions
  (plus local paths in any warnings). `/share` or `/export` of that session
  publishes them too. Review before sharing.
- **Narrow terminals:** pi shows all extension statuses on one line and cuts it
  off at the terminal width, so this status may be cut off.

## Development

```bash
npm test            # Vitest
npm run typecheck   # tsc --noEmit
npm run bench       # cold-start benchmark (synthetic)
npm run bench:large # peak memory parsing one large session (default 500 MB)
node bench/cold-start.ts --real [dir]   # against your sessions, read-only
```

Design notes, decisions and issues live in `.scratch/worktree-cost/`.

| Module                   | Role                                             |
| ------------------------ | ------------------------------------------------ |
| `src/worktree.ts`        | Find the Worktree and its lifetime (git).        |
| `src/discovery.ts`       | Session folder layout; which files to scan.      |
| `src/session-file.ts`    | Incremental JSONL parsing; billed entries.       |
| `src/aggregate.ts`       | Dedupe, lifetime filter, totals. Pure.           |
| `src/worktree-totals.ts` | Cached, incremental index over session files.    |
| `src/tracker.ts`         | Per-runtime tracker; folds in the live session.  |
| `src/format.ts`          | Footer and report formatting.                    |
| `src/extension.ts`       | pi glue: events, status, command, renderer.      |

## License

[MIT](LICENSE)
