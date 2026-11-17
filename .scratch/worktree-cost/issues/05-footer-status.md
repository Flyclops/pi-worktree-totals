# 05: Footer status

Status: resolved
Blocked by: 02, 04

Wire up the extension: on `session_start`, resolve the Worktree and do a full
scan. After each turn, refresh. Add the live current Session from
`ctx.sessionManager.getEntries()` (this covers `--no-session`), deduped
against what was found on disk. Show `wt $X.XXX` with `ctx.ui.setStatus`.
Clear state on `session_shutdown`. Skip the UI when `!ctx.hasUI`.

## Acceptance

- Manual: two panes in one Worktree, and each footer reflects the other's
  spend after a turn.
- Manual: `/fork` doesn't raise the Worktree Cost.
- Manual: `--no-session` spend shows live.

## Comments

- Code done: `src/extension.ts` (glue), `src/tracker.ts` (tracker and live
  Session). Tests: `test/extension.test.ts` (fake pi), `test/tracker.test.ts`.
  Status set to ready-for-human for the three manual checks above.
- Verified in a real pi (`pi --mode rpc -e .`): the status goes `wt …` →
  `wt $6.801`, then clears on shutdown. The total matched pi's own
  `getUsageCostBreakdown` summed over this worktree's session files
  ($6.854 = $6.854 at check time).
- Handlers never block: work runs in the background, and results from an
  old session runtime are dropped via a generation counter (pi's
  session-replacement footgun).
- Refresh triggers: `turn_end`, `agent_settled` (retries,
  auto-compaction), `session_compact`, `session_tree` (branch summaries).
- The live Session (from `getEntries()`) replaces its own file in the
  aggregate. That covers `--no-session` and entries not yet on disk, without
  listing the Session twice.
- Each distinct warning or error is notified once per session runtime.
  Failures show `wt $?`.
- Manual checks passed (user): two panes, /fork, --no-session.
- Bug found later (issue 06): `--no-session` missed saved sessions
  (empty session dir). Fixed in `detectLayout`.
