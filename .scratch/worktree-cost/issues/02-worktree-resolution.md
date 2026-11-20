# 02: Resolve Worktree and Worktree Lifetime

Status: resolved
Blocked by: 01

Given a cwd, return `{ root, lifetimeStart | null }`.

- `root`: `git rev-parse --show-toplevel`; if not in a git repo, the cwd.
- Linked worktree (`--git-dir` differs from `--git-common-dir`): lifetimeStart
  = creation time of `<common>/worktrees/<name>`. Use birthtime, falling back
  to the earliest mtime among its files when birthtime isn't available
  (Linux).
- Main checkout or non-git folder: `lifetimeStart = null` (no bound).

## Acceptance

- Unit tests that use temporary git repos and worktrees: main checkout, linked
  worktree, subfolder cwd, non-git folder, worktree recreated at the same path.

## Comments

- Done in `src/worktree.ts`, tests in `test/worktree.test.ts` (9).
- Uses `git rev-parse --path-format=absolute` (git ≥ 2.31) with `LC_ALL=C`,
  so the "not a git repository" check is locale-independent. Any other git
  failure throws `WorktreeResolutionError` (with `cause`).
- Roots are realpath'd (macOS `/var` → `/private/var`).
