import type { DiffLine, FileDiff, Hunk, ParsedDiff } from './parse.js'
import type { FileSelection } from './select.js'
import { quotePath } from './parse.js'

/**
 * Patch emission: filter hunk lines to a selection and rebuild a valid unified diff.
 *
 * Two invariants come straight from hunkpick (MIT), tests/renumber.rs and ADR 0010:
 *
 * 1. Unselected deletions become context lines; unselected additions are dropped.
 *    Context is always kept whole, so a subset applies with no boundary restriction.
 *
 * 2. New-side hunk anchors are recomputed from the result, never inherited from the
 *    input. Dropping a hunk or slicing one with @L changes the net line count of
 *    everything above, and `git apply` searches from the new-side position — a stale
 *    anchor can silently apply to the wrong copy of duplicated context.
 */

export interface EmittedHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  section: string
  lines: DiffLine[]
}

export interface EmittedFile {
  file: FileDiff
  hunks: EmittedHunk[]
}

/**
 * The 1-based position a hunk's side starts at, given the header's start and count.
 * A zero count means the side contributes nothing there — a pure insertion has no old-side
 * lines, a pure deletion no new-side lines — and git writes the *preceding* line number
 * (`@@ -2,0 +3 @@`, `@@ -3 +2,0 @@`).
 */
function anchor(start: number, count: number): number {
  return start + (count === 0 ? 1 : 0)
}

/** Filter one hunk's lines to the selected changed-line indices. */
export function filterHunkLines(hunk: Hunk, selected: Set<number>): DiffLine[] {
  let changedIndex = 0
  const out: DiffLine[] = []
  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      out.push(line)
      continue
    }
    changedIndex++
    const keep = selected.has(changedIndex)
    if (line.kind === 'add') {
      if (keep)
        out.push(line)
      // Dropped additions disappear together with their no-newline marker:
      // the index keeps the old ending, which is what the remaining lines describe.
      continue
    }
    // Deletion: kept stays '-', unselected becomes context (the line stays in the index).
    if (keep)
      out.push(line)
    else
      out.push({ ...line, kind: 'context' })
  }
  return out
}

function changeCounts(lines: DiffLine[]): { add: number, del: number } {
  let add = 0
  let del = 0
  for (const line of lines) {
    if (line.kind === 'add')
      add++
    else if (line.kind === 'del')
      del++
  }
  return { add, del }
}

/**
 * Build the emission plan: filter lines, drop empty hunks/files, recompute new-side
 * anchors per file from the result itself.
 */
export function planEmission(selections: FileSelection[]): EmittedFile[] {
  const out: EmittedFile[] = []
  for (const sel of selections) {
    if (sel.wholeFile) {
      out.push({ file: sel.file, hunks: sel.file.hunks.map(h => ({ ...h, lines: h.lines })) })
      continue
    }
    const emitted: EmittedHunk[] = []
    let delta = 0
    for (const { hunk, selected } of sel.hunks) {
      const lines = filterHunkLines(hunk, selected)
      const { add, del } = changeCounts(lines)
      if (add === 0 && del === 0)
        continue
      const oldLines = hunk.oldLines // context + all deletions survive on the old side
      const newLines = lines.length - del
      const a = anchor(hunk.oldStart, oldLines) + delta
      const newStart = Math.max(0, newLines === 0 ? a - 1 : a)
      emitted.push({
        oldStart: hunk.oldStart,
        oldLines,
        newStart,
        newLines,
        section: hunk.section,
        lines,
      })
      delta += add - del
    }
    if (emitted.length > 0 || (sel.file.hunks.length === 0 && sel.wholeFile))
      out.push({ file: sel.file, hunks: emitted })
  }
  return out
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`
}

function markerLine(path: string | null, prefix: 'a' | 'b'): string {
  return path === null ? '/dev/null' : quotePath(`${prefix}/${path}`)
}

/** Serialize the emission plan back to a unified diff. */
export function emitPatch(planned: EmittedFile[], preamble: string[] = [], noTrailingNewline = false): string {
  const out: string[] = [...preamble]
  for (const { file, hunks } of planned) {
    const oldName = file.oldPath ?? file.newPath
    const newName = file.newPath ?? file.oldPath
    out.push(`diff --git ${quotePath(`a/${oldName ?? file.path}`)} ${quotePath(`b/${newName ?? file.path}`)}`)
    out.push(...file.headers)
    if (file.status !== 'binary') {
      out.push(`--- ${markerLine(file.oldPath, 'a')}`)
      out.push(`+++ ${markerLine(file.newPath, 'b')}`)
    }
    let emittedHunks = 0
    const trailer = [...file.trailer].sort((a, b) => a.afterHunk - b.afterHunk)
    const flushTrailer = (upto: number): void => {
      while (trailer.length > 0 && trailer[0]!.afterHunk <= upto)
        out.push(trailer.shift()!.text)
    }
    flushTrailer(-1)
    for (const hunk of hunks) {
      out.push(`@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@${hunk.section ? ` ${hunk.section}` : ''}`)
      for (const line of hunk.lines) {
        const tag = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
        out.push(tag + line.text)
        if (line.noNewline !== null)
          out.push(line.noNewline)
      }
      emittedHunks++
      flushTrailer(emittedHunks - 1)
    }
    flushTrailer(Number.MAX_SAFE_INTEGER)
  }
  const text = out.join('\n')
  return noTrailingNewline ? text : `${text}\n`
}

/** Convenience: parse → resolve → plan → emit in one call. */
export function buildPatch(diff: ParsedDiff, selections: FileSelection[]): string {
  const planned = planEmission(selections)
  return emitPatch(planned, diff.preamble, diff.noTrailingNewline)
}
