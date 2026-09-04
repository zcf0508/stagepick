# stagepick

[![CI](https://github.com/zcf0508/stagepick/actions/workflows/ci.yml/badge.svg)](https://github.com/zcf0508/stagepick/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/zcf0508/stagepick)](https://github.com/zcf0508/stagepick/blob/main/LICENSE)

Non-interactive git staging for AI agents and scripts. Stage hunks or individual
lines by stable content ids and file line numbers — no TTY, no hand-written patches.

## Why

`git add -p` needs a human at a terminal. Hand-built patches fed to
`git apply --cached` break on hunk-header arithmetic. Shell pipelines
(`git diff | … | git apply --cached`) corrupt bytes on Windows PowerShell 5.1.
Agents need a deterministic, scriptable way to say *"stage exactly these lines"*
and have it work on every platform.

stagepick gives you that:

```bash
stagepick list --json                  # inspect changes: files, hunks, stable ids, line numbers
stagepick stage a1b2c3d4               # stage one hunk by content id
stagepick stage src/app.ts:42-45       # stage the change runs touching those lines
stagepick stage a1b2c3d4@L2            # stage one changed line inside a hunk
git diff --cached                      # verify, then commit as usual
```

## Features

- **Hunk-level staging** by content-addressed id (stable across re-diffs and
  staging of other hunks — loop-staging friendly)
- **Line-level staging** two ways: new-file line ranges (`path:42-45`) that select
  whole change runs, and individual changed lines (`id@L1,3-5`) for surgical splits
  like separating a replacement's deletion from its addition
- **Correct anchors, always**: new-side hunk anchors are recomputed from the result,
  so a partial patch applies where it belongs — never onto the wrong copy of
  duplicated context
- **Byte-faithful**: UTF-8 content, CRLF line endings, `\ No newline` markers,
  renames, mode changes and `format-patch` preambles all round-trip intact
- **Safe failures**: an inapplicable patch is rejected by git atomically — the
  index is never left half-written
- **Cross-platform by construction**: git is driven through shell-free process
  pipes, immune to PowerShell pipeline encoding damage
- **Zero-config CLI + a library**: use the `stagepick` binary directly, or embed
  `@stagepick/core` in your agent runtime

## Install

```bash
npm install -g stagepick        # the CLI
npx stagepick list              # or run without installing
npm install @stagepick/core     # the library
```

Requires Node.js ≥ 20 and `git` on `PATH`.

## CLI

### `stagepick list [--json] [--lines] [--staged] [--cwd DIR]`

Lists unstaged changes (worktree vs index), or staged ones with `--staged`.
Untracked files appear as hunks-less entries.

Human output (compact, one line per hunk):

```
src/app.ts (modified, 2 hunks)
  5155d12f  @@ -5,7 +5,7 @@  +1 -1  -const retries = 3
  d9de73e6  @@ -27,8 +27,8 @@  +2 -2  -function fetch() {
```

`--lines` adds the changed lines with their L-numbers; `--json` emits the full
structured model (same numbering) — the agent-facing contract:

```jsonc
{
  "files": [
    {
      "path": "src/app.ts",
      "status": "modified",
      "hunks": [
        {
          "id": "5155d12f",
          "idCount": 1,
          "header": "@@ -5,7 +5,7 @@",
          "changedLines": [
            { "i": 1, "kind": "del", "text": "const retries = 3", "oldLine": 8, "newLine": null },
            { "i": 2, "kind": "add", "text": "const retries = 5", "oldLine": null, "newLine": 8 }
          ]
        }
      ]
    }
  ]
}
```

### `stagepick stage <selectors...> [--dry-run] [--cwd DIR]`

Stages the selected changes into the index. `git add -N` is applied
automatically when a line selector targets an untracked file; whole-file
selectors stage untracked files via `git add`.

### `stagepick unstage <selectors...> [--dry-run] [--cwd DIR]`

Removes the selected changes from the index (reverse apply), same selector
grammar over `stagepick list --staged`.

### Selectors

| Form | Meaning |
| --- | --- |
| `path` | whole file (untracked files stage whole) |
| `a1b2c3d4` | hunk by content id (prefix-match, 4–40 hex) |
| `path#a1b2c3d4` | hunk by id, restricted to one file |
| `path:42-45,50` | new-file line ranges; selects whole **change runs** touching them |
| `a1b2c3d4@L1,3-5` | individual changed (+/-) lines of a hunk (L-numbers from `list`) |
| `path#a1b2c3d4@L2` | same, restricted to one file |

Semantics worth knowing:

- **Hunk ids are content-addressed** (file path + changed lines). They survive
  re-diffs and staging of other hunks, and change only when the hunk's own
  +/- lines change. After staging part of a hunk, re-run `list` for fresh ids.
- **Identical edits in one file share an id** and are selected together;
  `list --json` reports `idCount` upfront.
- **A change run** is a maximal block of consecutive +/- lines. `path:42-45`
  stages every run the range touches, atomically — a replacement's deletion and
  addition can only be split with `@L`, not with line ranges.
- **A token that looks like an id but matches no hunk** falls back to a
  whole-file selection (for files named like `deadbee`). Prefix `./` to force
  the file reading.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | git failed (e.g. patch does not apply; index untouched) |
| 2 | usage error (bad selector, unknown id, nothing selected) |

## Library

```ts
import { createStagepick } from '@stagepick/core'

const sp = createStagepick({ cwd: process.cwd() })

const diff = sp.list() // ParsedDiff, untracked included
const id = diff.files[0]!.hunks[0]!.id

const result = sp.stage([id], { dryRun: true })
console.log(result.patch) // the exact patch, nothing applied

sp.stage(['src/app.ts:42-45']) // returns { hunks, files, addedUntracked, ... }
sp.unstage(['a1b2c3d4@L2']) // reverse apply against the index
```

All primitives are exported for custom pipelines: `parseDiff`, `parseSelector`,
`resolveSelectors`, `changeRuns`, `filterHunkLines`, `planEmission`, `emitPatch`,
`buildPatch`, `formatHuman`, `formatJson`, `toJsonModel`, `createGitRunner`.
Inject your own `GitRunner` via `createStagepick({ git })` for tests or remote
execution.

## How it stays correct

- New-side hunk anchors are **recomputed from the result patch**, never inherited
  from the input — dropping a hunk or slicing one with `@L` shifts every later
  anchor (see `packages/core/test/patch.test.ts`, ported from hunkpick's
  renumber and new-side-anchor suites).
- Unselected deletions become context, unselected additions are dropped, and
  context is kept whole, so a subset patch always applies without boundary
  tricks.
- Patches travel from `git diff` to `git apply --cached` through in-memory
  process pipes — never through a shell — so no platform gets to re-encode them.

## Acknowledgements

Core invariants and several test suites are ported from
[hunkpick](https://github.com/VitalyOstanin/hunkpick) (MIT) — notably the
new-side anchor recomputation (`tests/renumber.rs`, `tests/new_side_anchors.rs`)
and its edge-case corpus. stagepick reuses the semantics, not the code, and adds
stable hunk ids, new-file line-range selectors and a library API on top.

## License

[MIT](./LICENSE)
