# 04: Incremental refresh

Status: resolved
Blocked by: 03

Keep an in-memory index of `{ file → mtime, size, entries }`. On refresh, stat
the candidate files, re-parse only the ones that changed, and pick up new
files. Deleted files drop out (ADR-0001).

## Acceptance

- Tests: an appended entry is picked up, an unchanged file isn't re-parsed, a
  deleted file is removed, a new file from another process is found.

## Comments

- Done: `WorktreeCostIndex` in `src/worktree-cost.ts`, with incremental
  parsing in `src/session-file.ts`. Tests: `test/index.test.ts` (13),
  mutation-checked (removing each guard fails a test).
- Went past stat-gating to **append-only parsing**: the largest real session
  file (36 MB) takes ~60 ms to fully re-parse, which would block pi's event
  loop every turn. Resumes from a byte offset when the header line is
  unchanged and the file grew; otherwise re-parses fully. pi only rewrites a
  file in place for format migrations, which change the header.
- Only complete lines are consumed, so a line another pi process is mid-way
  through writing is picked up next refresh instead of warning.
- Files from other Worktrees are never stat'd again (a Session's cwd is
  immutable).
- Concurrent `refresh()` calls are serialized and coalesced.
  `refresh(extra)` accepts live sessions for issue 05.
- Bench, unchanged refresh (median): this worktree 0.5 ms; synthetic 1000
  files 1.6 ms; worst case `~` (170 sessions) 2.3 ms.
- Added `erasableSyntaxOnly` to tsconfig so `node bench/*.ts` (type
  stripping) and jiti both run the sources.
- Noticed: pi-subagents writes nested runs under
  `<cwd-folder>/<session>/<run>/run-0/session.jsonl`. These aren't counted
  (Q15); a cheap v2 option is to recurse within matching folders.
