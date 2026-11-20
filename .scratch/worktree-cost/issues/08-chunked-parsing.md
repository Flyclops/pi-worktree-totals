# 08: Bound memory when parsing large session files

Status: ready-for-agent
Blocked by: none

From the pre-push security review (low severity).

`readSessionFile` (`src/session-file.ts`) reads the whole unread part of a
file into one `Buffer`, decodes it to one string, splits it, and keeps every
parsed entry in an array before folding. Up to 16 files are read at once
(`src/worktree-totals.ts`). On a cold start, several image-heavy sessions of
100 MB or more could briefly use GBs inside pi's process. A file over ~512 MB
fails the decode and silently drops out with a warning.

## Fix

- Read in fixed chunks (4–8 MB), carrying the partial trailing line over to
  the next chunk; `offset` still only advances past complete lines.
- Fold each entry into the state as it's parsed (no `entries` array).
- Optionally lower concurrency for files above a size threshold.
- Truncate `firstPrompt` when stored, not only at display (holds full
  prompts in memory today).
- Dedupe the malformed-line warning by file path, so a growing count doesn't
  notify again each time (the review's info note).

## Acceptance

- A test with a chunk size forced small (e.g. 64 bytes) produces the same
  results as whole-file parsing, including lines that span chunks and
  multi-byte UTF-8 split across a chunk boundary.
- Benchmark: peak RSS when parsing a synthetic 500 MB session stays bounded,
  with the number noted in Comments.

## Comments
