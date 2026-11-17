# 03: Worktree Cost core (pure)

Status: resolved
Blocked by: 01

Pure module: inputs are the active session folder, the agent dir, the Worktree
root and lifetimeStart.
It returns the Worktree Cost, a list of `{ file, name|firstPrompt, startedAt,
cost }` per Session, and `{ model → cost }`.

- Work out the scan set exactly as in the spec's "Session discovery"
  section: if the active folder's parent is `<agentDir>/sessions` and its
  name matches `--*--`, scan every `--*--` sibling. Otherwise treat it as a
  custom flat folder and scan only its top-level `*.jsonl` files. Don't
  copy pi's private folder-name encoding.
- Keep a file only if its header `cwd` is the Worktree root or beneath it.
  Never decode folder names.
- Count billed entries exactly as listed in the spec's "Billed entries"
  section.
- Skip Inherited Entries: dedupe on `id` + `timestamp` across files.
- Keep only entries whose timestamp is at or after lifetimeStart.
- A Session's cost in the breakdown is its own non-inherited spend.
- Malformed lines: skip the line and record a warning; never throw for one bad
  file.

## Acceptance

- Layout detection tests: the default layout finds sibling subfolder and
  `/resume` Sessions; a custom flat folder scans only itself; a default
  folder whose name doesn't match the current cwd's encoding is still
  treated as the default layout.
- Fixture JSONL tests: fork/clone dedupe, entries before lifetimeStart, a
  subfolder cwd, a `/resume`-moved cwd, abandoned `/tree` branch counted,
  `usage`/compaction/branch_summary counted, a custom flat `sessionDir`.
- A cold-start benchmark against a synthetic 100-folder sessions root, with
  the result noted in Comments.

## Comments

- Done in `src/session-file.ts`, `src/discovery.ts`, `src/aggregate.ts` and
  `src/worktree-cost.ts`. Tests: `test/discovery.test.ts`,
  `test/worktree-cost.test.ts`, `test/pi-parity.test.ts`.
- Added a second Inherited Entry rule beyond the id+timestamp dedupe: in a
  session with `parentSession`, entries older than the header are
  inherited. Fork/clone keep the original timestamps and stamp the header at
  fork time. This catches forks from a parent *outside* the Worktree (e.g.
  `pi --fork` from main into a new worktree), which dedupe alone can't.
- The parity test imports pi's `getUsageCostBreakdown` by file path from the
  pinned devDependency. If pi changes its billing rules, the test fails.
- Session cwds are realpath'd (memoised), so symlinked cwds still match.
- Unreadable or invalid files become warnings; filesystem errors on the
  scan root propagate. No console logging (it would corrupt the TUI).
  Issue 05 surfaces warnings in the UI.
- Benchmark (`npm run bench`, M-series Mac, warm page cache, median of 7):
  - synthetic: 100 folders, 1000 files, 233 MB, 50 matching → 24 ms
  - real, this worktree (2 sessions) → 4 ms
  - real, worst case root `~` (all 310 files, 115 MB parsed,
    169 sessions) → 163 ms
  The scan is cheap enough to run per turn even before issue 04's
  incremental index.
