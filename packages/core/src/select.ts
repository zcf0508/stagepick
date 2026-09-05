import type { DiffLine, FileDiff, Hunk, ParsedDiff } from './parse.js'
import type { Selector } from './selector.js'
import { StagepickError } from './errors.js'
import { changedLines } from './parse.js'

/** One hunk with the subset of its changed lines selected (1-based changed-line indices). */
export interface HunkSelection {
  hunk: Hunk
  selected: Set<number>
}

export interface FileSelection {
  file: FileDiff
  /** Whole-file selection (binary files, untracked additions staged wholesale). */
  wholeFile: boolean
  hunks: HunkSelection[]
}

export class SelectionError extends StagepickError {
  override readonly name = 'SelectionError'

  constructor(
    message: string,
    /** Machine-branchable kind; all selection failures are recoverable by re-listing. */
    readonly reason: 'unknown-hunk' | 'unknown-path' | 'lines-not-matched' | 'changed-line-out-of-range' | 'nothing-to-stage',
  ) {
    super(message, reason, true)
  }
}

/**
 * A maximal run of consecutive changed (+/-) lines inside a hunk, delimited by context lines.
 * File line-number selectors address runs, not individual lines: a replacement (deletions
 * followed by additions with no context between) is staged atomically.
 */
export interface ChangeRun {
  /** 1-based changed-line indices belonging to this run. */
  indices: number[]
  /**
   * New-side line span the run answers to. For runs containing additions this is
   * [first added line, last added line]. For pure deletions it is [anchor, anchor] where
   * anchor is the new-file line number the deletion sits before.
   */
  newStart: number
  newEnd: number
}

export function changeRuns(hunk: Hunk): ChangeRun[] {
  const runs: ChangeRun[] = []
  let current: Array<{ index: number, line: DiffLine, lineIndex: number }> = []

  const flush = (): void => {
    if (current.length === 0)
      return
    const added = current.filter(e => e.line.newLine !== null).map(e => e.line.newLine!)
    let newStart: number
    let newEnd: number
    if (added.length > 0) {
      newStart = added[0]!
      newEnd = added[added.length - 1]!
    }
    else {
      // Pure deletion: address it by the new-file line it sits before — the new-side
      // number of the context line above the run, plus one.
      const firstLineIndex = current[0]!.lineIndex
      const prevLine = firstLineIndex > 0 ? hunk.lines[firstLineIndex - 1] : undefined
      const anchor = prevLine?.newLine != null ? prevLine.newLine + 1 : hunk.newStart
      newStart = anchor
      newEnd = anchor
    }
    runs.push({ indices: current.map(e => e.index), newStart, newEnd })
    current = []
  }

  for (const entry of changedLines(hunk)) {
    current.push(entry)
    // A run ends where a context line (or the end of the hunk body) follows.
    const nextBody = hunk.lines[entry.lineIndex + 1]
    if (!nextBody || nextBody.kind === 'context')
      flush()
  }
  flush()
  return runs
}

function findFile(diff: ParsedDiff, path: string): FileDiff | undefined {
  const normalized = path.replace(/\\/g, '/')
  return diff.files.find(f => f.path === normalized || f.oldPath === normalized || f.newPath === normalized)
}

function findHunks(diff: ParsedDiff, id: string, path: string | null): Array<{ file: FileDiff, hunk: Hunk }> {
  const matches: Array<{ file: FileDiff, hunk: Hunk }> = []
  for (const file of diff.files) {
    if (path !== null && file.path !== path && file.oldPath !== path && file.newPath !== path)
      continue
    for (const hunk of file.hunks) {
      if (hunk.id.startsWith(id))
        matches.push({ file, hunk })
    }
  }
  return matches
}

function addHunkSelection(
  map: Map<FileDiff, Map<Hunk, Set<number>>>,
  file: FileDiff,
  hunk: Hunk,
  indices: Iterable<number>,
): void {
  let fileMap = map.get(file)
  if (!fileMap) {
    fileMap = new Map()
    map.set(file, fileMap)
  }
  let set = fileMap.get(hunk)
  if (!set) {
    set = new Set()
    fileMap.set(hunk, set)
  }
  for (const i of indices) set.add(i)
}

function wholeHunkIndices(hunk: Hunk): number[] {
  return changedLines(hunk).map(c => c.index)
}

/** Select a file wholesale: every hunk fully, or the whole entry when hunk-less (binary). */
function selectWholeFile(
  hunkMap: Map<FileDiff, Map<Hunk, Set<number>>>,
  wholeFiles: Set<FileDiff>,
  file: FileDiff,
): void {
  if (file.hunks.length === 0) {
    wholeFiles.add(file)
    return
  }
  for (const hunk of file.hunks)
    addHunkSelection(hunkMap, file, hunk, wholeHunkIndices(hunk))
}

/**
 * Resolve selectors against a parsed diff into per-hunk changed-line selections.
 * Throws SelectionError on unknown ids, ambiguous ids, missing files and out-of-range lines.
 */
export function resolveSelectors(diff: ParsedDiff, selectors: Selector[]): FileSelection[] {
  const hunkMap = new Map<FileDiff, Map<Hunk, Set<number>>>()
  const wholeFiles = new Set<FileDiff>()

  for (const sel of selectors) {
    if (sel.kind === 'file') {
      const file = findFile(diff, sel.path)
      if (!file)
        throw new SelectionError(`no changes found for path "${sel.path}"`, 'unknown-path')
      // A file selector expands to "every hunk fully selected", so the emission
      // still recomputes counts and new-side anchors like any other selection.
      selectWholeFile(hunkMap, wholeFiles, file)
      continue
    }

    if (sel.kind === 'hunk' || sel.kind === 'hunkLines') {
      const matches = findHunks(diff, sel.id, sel.path)
      if (matches.length === 0) {
        // A token that looks like an id may actually be a file whose name is all hex
        // ("1234", "deadbee"): fall back to a whole-file selection.
        if (sel.kind === 'hunk' && sel.path === null) {
          const file = findFile(diff, sel.id)
          if (file) {
            selectWholeFile(hunkMap, wholeFiles, file)
            continue
          }
        }
        throw new SelectionError(`no hunk matches id "${sel.id}"${sel.path ? ` in ${sel.path}` : ''} — re-run \`stagepick list\`; ids change when a hunk's own edited lines change. If "${sel.id}" is a file path, prefix it with ./`, 'unknown-hunk')
      }
      // Identical edits in one file share a content id (same path, same +/- lines):
      // like hunkpick's @id, select them all. list --json reports idCount upfront.
      for (const { file, hunk } of matches) {
        const indices = sel.kind === 'hunk' ? wholeHunkIndices(hunk) : sel.lines
        if (sel.kind === 'hunkLines') {
          const max = changedLines(hunk).length
          for (const n of sel.lines) {
            if (n < 1 || n > max)
              throw new SelectionError(`changed line ${n} is out of range 1..${max} for hunk ${hunk.id} in ${file.path}`, 'changed-line-out-of-range')
          }
        }
        addHunkSelection(hunkMap, file, hunk, indices)
      }
      continue
    }

    // sel.kind === 'lines'
    const file = findFile(diff, sel.path)
    if (!file)
      throw new SelectionError(`no changes found for path "${sel.path}"`, 'unknown-path')
    if (file.status === 'binary')
      throw new SelectionError(`"${sel.path}" is binary; stage it whole with \`stagepick stage ${sel.path}\``, 'lines-not-matched')
    let matched = false
    for (const hunk of file.hunks) {
      for (const run of changeRuns(hunk)) {
        const hit = sel.ranges.some(([lo, hi]) => run.newStart <= hi && run.newEnd >= lo)
        if (hit) {
          addHunkSelection(hunkMap, file, hunk, run.indices)
          matched = true
        }
      }
    }
    if (!matched) {
      const spec = sel.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',')
      throw new SelectionError(`lines ${spec} in "${sel.path}" do not touch any change — line numbers are new-file lines; check \`stagepick list --lines\``, 'lines-not-matched')
    }
  }

  const out: FileSelection[] = []
  for (const file of diff.files) {
    const whole = wholeFiles.has(file)
    const fileMap = hunkMap.get(file)
    if (!whole && (!fileMap || fileMap.size === 0))
      continue
    const hunks: HunkSelection[] = []
    if (fileMap) {
      for (const hunk of file.hunks) {
        const selected = fileMap.get(hunk)
        if (selected)
          hunks.push({ hunk, selected })
      }
    }
    out.push({ file, wholeFile: whole && hunks.length === 0, hunks })
  }
  return out
}
