# pi-worktree-totals

A pi extension that reports how much model spend a git working tree has
accumulated across every pi Session run inside it.

## Language

**Worktree**:
The top-level directory of a git working tree, either a linked worktree or a
repo's main checkout, identified by its absolute path. Outside git, the
directory pi was started in.
_Avoid_: repo, project, branch, workspace

**Session**:
One pi conversation, persisted by pi as a single session file. A Session
belongs to a Worktree when its recorded working directory is the Worktree or
lies beneath it.
_Avoid_: conversation, run, chat

**Worktree Cost**:
The total billed model cost of every Session belonging to a Worktree, counting
each billed entry exactly once.
_Avoid_: worktree total, cumulative cost, spend

**Worktree Totals**:
The Worktree Cost together with the token totals (input, output, cache
read, cache write) of the same billed entries, counted by the same rules.
_Avoid_: worktree usage, worktree stats

**Session Cost**:
The cost pi itself reports for one Session, including abandoned branches and
any Inherited Entries.
_Avoid_: current cost

**Inherited Entry**:
An entry copied into a Session from its parent by a fork or clone. It was
billed once, in the parent, and is not new spend.
_Avoid_: duplicate, copied message

**Worktree Lifetime**:
The span from a Worktree's creation to now. Only billed entries made within
it count toward Worktree Cost, so a Worktree recreated at a reused path starts
from zero. A main checkout's lifetime has no start bound.
_Avoid_: history, age
