import type { GitRunner } from './git.js'
import type { ParsedDiff } from './parse.js'
import type { Selector } from './selector.js'
import process from 'node:process'
import { PartialFailureError } from './errors.js'
import { createGitRunner } from './git.js'
import { parseDiff } from './parse.js'
import { buildPatch } from './patch.js'
import { resolveSelectors, SelectionError } from './select.js'
import { parseSelector } from './selector.js'

/**
 * High-level API for embedding stagepick into agent runtimes and other tooling.
 * Pure-function primitives (parse/select/patch) stay exported alongside for
 * custom pipelines; this facade wires them to a git runner with sensible defaults.
 */

export interface StagepickOptions {
  /** Repository directory. Defaults to process.cwd(). */
  cwd?: string
  /** Custom git runner (tests, remote execution, alternative transports). */
  git?: GitRunner
}

export interface ListOptions {
  /** List index-vs-HEAD (staged) changes instead of worktree-vs-index. */
  staged?: boolean
  /** Limit the list to Git pathspecs. An empty or omitted list includes all paths. */
  paths?: readonly string[]
}

export interface StageOptions {
  /** Build and return the patch without applying it. */
  dryRun?: boolean
}

export interface StageResult {
  /** The patch that was applied (or would be, on dryRun). Empty when only whole-file adds ran. */
  patch: string
  /** Number of hunks staged. */
  hunks: number
  /** Number of files those hunks belong to. */
  files: number
  /** Untracked files staged wholesale via `git add`. */
  addedUntracked: string[]
  /** True when nothing was applied (dryRun). */
  dryRun: boolean
}

export interface Stagepick {
  readonly cwd: string
  readonly git: GitRunner
  /** Parse the current diff. Untracked files are appended as hunks-less entries on unstaged lists. */
  list: (options?: ListOptions) => ParsedDiff
  /** Stage the selected hunks/lines into the index. Selectors use the CLI grammar. */
  stage: (selectors: readonly string[], options?: StageOptions) => StageResult
  /** Remove the selected hunks/lines from the index (reverse apply). */
  unstage: (selectors: readonly string[], options?: StageOptions) => StageResult
}

function untrackedEntries(paths: readonly string[]): ParsedDiff['files'] {
  return paths.map(path => ({
    path,
    oldPath: null,
    newPath: path,
    status: 'untracked' as const,
    headers: [],
    trailer: [],
    hunks: [],
  }))
}

export function createStagepick(options: StagepickOptions = {}): Stagepick {
  const cwd = options.cwd ?? process.cwd()
  const git = options.git ?? createGitRunner(cwd)

  function list(listOptions: ListOptions = {}): ParsedDiff {
    const staged = listOptions.staged ?? false
    const paths = listOptions.paths ?? []
    const diff = parseDiff(git.diff(staged, paths))
    if (!staged)
      diff.files.push(...untrackedEntries(git.untracked(paths)))
    return diff
  }

  function run(rawSelectors: readonly string[], reverse: boolean, stageOptions: StageOptions): StageResult {
    const selectors: Selector[] = rawSelectors.map(parseSelector)
    const dryRun = stageOptions.dryRun ?? false

    const untracked = reverse ? [] : git.untracked()
    const directAdd: string[] = []
    const intentToAdd: string[] = []
    const rest = selectors.filter((sel) => {
      if (sel.kind === 'file' && untracked.includes(sel.path)) {
        directAdd.push(sel.path)
        return false
      }
      if (sel.kind === 'lines' && untracked.includes(sel.path)) {
        intentToAdd.push(sel.path)
        return true
      }
      return true
    })

    if (intentToAdd.length > 0)
      git.addIntentToAdd([...new Set(intentToAdd)])

    const diff = parseDiff(git.diff(reverse))
    const selections = rest.length > 0 ? resolveSelectors(diff, rest) : []

    const hunkCount = selections.reduce((n, s) => n + s.hunks.length, 0)
    if (hunkCount === 0 && directAdd.length === 0)
      throw new SelectionError(reverse ? 'nothing to unstage' : 'nothing to stage', 'nothing-to-stage')

    const patch = hunkCount > 0 ? buildPatch(diff, selections) : ''
    if (!dryRun) {
      if (patch)
        git.applyToIndex(patch, reverse)
      if (directAdd.length > 0) {
        // Apply the failure-prone step first (above), then add untracked files one by
        // one so a failure reports exactly what landed — partial success is explicit.
        const added: string[] = []
        try {
          for (const path of directAdd) {
            git.add([path])
            added.push(path)
          }
        }
        catch (cause) {
          const remaining = directAdd.filter(p => !added.includes(p))
          throw new PartialFailureError(
            `${reverse ? 'unstage' : 'stage'} partially applied: the patch (${hunkCount} hunk(s)) is already in the index, and \`git add\` failed for: ${remaining.join(', ')}. Recover with \`git reset\` to undo the staged patch, or \`git add\` the remaining files manually.`,
            { patchApplied: hunkCount > 0, addedUntracked: added, remainingUntracked: remaining },
            cause,
          )
        }
      }
    }

    return {
      patch,
      hunks: hunkCount,
      files: new Set(selections.map(s => s.file.path)).size,
      addedUntracked: directAdd,
      dryRun,
    }
  }

  return {
    cwd,
    git,
    list,
    stage: (selectors, stageOptions = {}) => run(selectors, false, stageOptions),
    unstage: (selectors, stageOptions = {}) => run(selectors, true, stageOptions),
  }
}
