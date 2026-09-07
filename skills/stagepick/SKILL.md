---
name: stagepick
description: Stage specific git hunks or individual lines instead of whole files, using the stagepick CLI. Use when asked to stage part of a file, split mixed working-tree changes into atomic commits, separate your own edits from other agents' edits in a shared file, or when git add -p is unavailable (non-interactive shells, CI, scripts). Covers stable hunk ids, new-file line-range selectors (path:42-45), and per-changed-line selection (id@L1,3-5).
---

# stagepick: precise non-interactive git staging

## Goal

Commit exactly the changes you intend — nothing else in the file — without
hand-writing patches or driving interactive `git add -p`. stagepick turns
"stage these lines" into one deterministic command, and it never corrupts
line endings or encodings (git is driven through shell-free process pipes).

Requires the `stagepick` CLI on PATH (Node.js ≥ 20). Verify with
`stagepick --version`; if missing, tell the user to install it
(`npm install -g stagepick`) — do not hand-write patches as a substitute.

## Instructions

Default loop (copy this checklist for multi-commit splits):

1. **Inspect**: `stagepick list --toon` (TOON — compact machine-readable format,
   same data model as `--json` at a fraction of the tokens; use `--json` instead
   only if you must pipe stdout into a JSON parser).
   Pick selectors from the output. One call per staging round is usually enough.

   Reading TOON output: `files[N]:` lists each file with its status; every hunk
   carries `id`, `idCount`, `header`; `changedLines[N]{i,kind,text,oldLine,newLine}:`
   rows give the `@L` numbers (`i`), `kind` (`add`/`del`) and the line text.
   `[N]` is the declared row count, `{...}` the field list.
2. **Stage**: `stagepick stage <selectors...>` (quote selectors in PowerShell: `'a1b2c3d4@L2'`).
3. **Verify**: `git diff --cached --stat` (and `git diff` for what remains).
   If the staged content is wrong, `stagepick unstage <selectors>` or `git reset` and redo step 1.
4. **Commit** as usual. Repeat from step 1 for the next commit.

Selector grammar (one per argument):

| Form | Selects |
| --- | --- |
| `path` | whole file (untracked files stage whole via git add) |
| `a1b2c3d4` | hunk by content id (prefix ok, 4–40 hex) |
| `path#a1b2c3d4` | same, restricted to one file |
| `path:42-45,50` | every change run touching those new-file lines |
| `a1b2c3d4@L1,3-5` | individual changed lines of a hunk, by L-number |
| `path#a1b2c3d4@L2` | same, restricted to one file |

### Choosing the right selector

- Whole logical change = one hunk → hunk id (cheapest, stable across rounds).
- You know the lines you edited (new-file line numbers) → `path:42-45`.
- Part of a hunk, e.g. splitting a replacement's deletion from its addition,
  or one of several adjacent additions → `id@L<numbers>` from `list --toon`
  `changedLines[].i`.
- Untracked file, whole → `path`. Untracked file, by lines → `path:1-10`
  (stagepick applies intent-to-add automatically; a new file is a single run).

### Rules that prevent real failures

- **L-numbers are not file line numbers.** `@L` counts changed (+/-) lines in
  body order, deletions and additions share one numbering, exactly as shown by
  `list --toon` (`changedLines[].i`) or `list --lines`. Never guess them.
- **Line ranges select runs, not lines.** Consecutive +/- lines with no context
  between them are one atomic change run: `path:42` stages the whole run that
  touches line 42. To split inside a run you must use `@L`.
- **Hunk ids die when their own lines move.** Staging part of a hunk, or any
  edit to that hunk's +/- lines, changes its id. Whole-hunk ids survive staging
  of *other* hunks, so a `list → stage → stage → …` loop with whole-hunk ids
  needs only one list; any partial-hunk (@L) staging round must re-list first.
- **Identical edits share one id and stage together.** Check `idCount` in
  `list --toon`; when >1 use `path#id` and `@L` to address just one occurrence.
- **Dry-run when unsure**: `stagepick stage --dry-run <selectors>` prints the
  exact patch without touching the index.

### Error recovery

Errors are machine-branchable: in machine modes (`--toon` or `--json`), failures
always print JSON `{"error":{"code","message","retryable"}}` on stderr, and exit
codes classify the failure — never parse the message text for control flow.

- Exit 2 (usage: bad selector grammar, missing arguments) → fix the command line
  and retry; do not re-list.
- Exit 3 (invalid or stale selection: `unknown-hunk`, `unknown-path`,
  `lines-not-matched`, `changed-line-out-of-range`, `nothing-to-stage`) →
  re-run `stagepick list --toon` and rebuild selectors; ids may have changed.
- Exit 1 (git rejected the patch) → the index is untouched (git apply is
  atomic). Re-list, widen the selection (whole run, whole hunk, whole file),
  and retry. Report persistent failures instead of hand-editing a patch.
- Exit 4 (partial failure) → some writes already landed. The JSON error's
  message says what; recover with `git reset` or finish the remaining
  `git add` manually, then report what happened before continuing.
- Never write or edit a patch by hand; never pipe `git diff` through a shell —
  stagepick exists precisely to avoid both failure modes.

## Examples

### Example 1: split a file with two unrelated changes into two commits

```
$ stagepick list --lines
src/app.ts (modified, 2 hunks)
  5155d12f  @@ -5,7 +5,7 @@  +1 -1  -const retries = 3
    L1  -const retries = 3
    L2  +const retries = 5
  d9de73e6  @@ -27,8 +27,8 @@  +2 -2  -function fetch() {
    ...

$ stagepick stage 5155d12f
staged 1 hunk(s) in 1 file(s)
$ git diff --cached --stat && git commit -m "fix: raise retry limit"

$ stagepick stage d9de73e6   # id from the first list is still valid:
staged 1 hunk(s) in 1 file(s)  # only the hunk's own lines renumber it
$ git commit -m "refactor: rewrite fetch"
```

### Example 2: separate a replacement's deletion from its addition

Goal: commit the removal of `oldParser()` and the introduction of
`newParser()` as two commits. Both edits are one changed line each inside the
same hunk.

```
$ stagepick list --toon   # hunk 91ab34cd, changedLines: i=1 del oldParser, i=2 add newParser
$ stagepick stage 91ab34cd@L1   # stage only the deletion
$ git commit -m "refactor: drop old parser call"
$ stagepick list --toon         # re-list: the hunk id changed after the split
$ stagepick stage <new-id>@L1   # the remaining addition is now L1
$ git commit -m "feat: use new parser"
```

### Example 3: shared file in a multi-agent session

Two agents edited `src/config.ts`; you must commit only your feature. Inspect
`list --toon`, match `changedLines[].text` to your edits, stage your runs by
`path:line-range` or hunk id, verify with `git diff --cached` that no foreign
change slipped in, then commit. Leave the rest in the worktree for the others.

## Constraints

- Do not assume stagepick is installed; check `stagepick --version` first.
- Always verify with `git diff --cached` before committing a partial staging.
- Never bypass stagepick with hand-written patches or shell diff pipelines.
- `unstage` only removes changes from the index; it never deletes worktree
  content. There is intentionally no discard command.
- Destructive git operations (`git reset --hard`, `checkout --`) are out of
  scope for this skill; ask the user before running them.
