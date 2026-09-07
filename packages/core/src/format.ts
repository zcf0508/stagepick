import type { FileStatus, Hunk, ParsedDiff } from './parse.js'
import { encode } from '@toon-format/toon'
import { changedLines } from './parse.js'

/** Human and machine renderings of a parsed diff. The JSON/TOON model is the agent-facing contract. */

export interface JsonChangedLine {
  /** 1-based changed-line index within the hunk (the L-number used by @L selectors). */
  i: number
  kind: 'add' | 'del'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface JsonHunk {
  id: string
  /** How many hunks in this diff share the same content id (identical edits). >1 means an @id selector stages them all. */
  idCount: number
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  added: number
  deleted: number
  changedLines: JsonChangedLine[]
}

export interface JsonFile {
  path: string
  oldPath: string | null
  newPath: string | null
  status: FileStatus
  binary: boolean
  hunks: JsonHunk[]
}

export interface JsonModel {
  files: JsonFile[]
}

function hunkHeader(hunk: Hunk): string {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return hunk.section ? `${range} ${hunk.section}` : range
}

export function toJsonModel(diff: ParsedDiff): JsonModel {
  const idCounts = new Map<string, number>()
  for (const file of diff.files) {
    for (const hunk of file.hunks)
      idCounts.set(hunk.id, (idCounts.get(hunk.id) ?? 0) + 1)
  }
  return {
    files: diff.files.map((file) => {
      const hunks = file.hunks.map((hunk): JsonHunk => {
        const changed = changedLines(hunk)
        return {
          id: hunk.id,
          idCount: idCounts.get(hunk.id) ?? 1,
          header: hunkHeader(hunk),
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          added: changed.filter(c => c.line.kind === 'add').length,
          deleted: changed.filter(c => c.line.kind === 'del').length,
          changedLines: changed.map(c => ({
            i: c.index,
            kind: c.line.kind === 'add' ? 'add' as const : 'del' as const,
            text: c.line.text,
            oldLine: c.line.oldLine,
            newLine: c.line.newLine,
          })),
        }
      })
      return {
        path: file.path,
        oldPath: file.oldPath,
        newPath: file.newPath,
        status: file.status,
        binary: file.status === 'binary',
        hunks,
      }
    }),
  }
}

export function formatJson(diff: ParsedDiff): string {
  return JSON.stringify(toJsonModel(diff), null, 2)
}

/** Same model as formatJson, encoded as TOON (https://github.com/toon-format/toon) for fewer LLM tokens. */
export function formatToon(diff: ParsedDiff): string {
  return encode(toJsonModel(diff))
}

function previewOf(hunk: Hunk): string {
  const first = changedLines(hunk)[0]
  if (!first)
    return ''
  const tag = first.line.kind === 'add' ? '+' : '-'
  const text = first.line.text.replace(/\r$/, '')
  const one = `${tag}${text}`
  return one.length > 96 ? `${one.slice(0, 95)}…` : one
}

export function formatHuman(diff: ParsedDiff, opts: { lines: boolean }): string {
  const out: string[] = []
  for (const file of diff.files) {
    const hunkWord = file.hunks.length === 1 ? '1 hunk' : `${file.hunks.length} hunks`
    out.push(`${file.path} (${file.status}, ${hunkWord})`)
    for (const hunk of file.hunks) {
      const changed = changedLines(hunk)
      const added = changed.filter(c => c.line.kind === 'add').length
      const deleted = changed.length - added
      out.push(`  ${hunk.id}  ${hunkHeader(hunk)}  +${added} -${deleted}  ${previewOf(hunk)}`)
      if (opts.lines) {
        for (const c of changed) {
          const tag = c.line.kind === 'add' ? '+' : '-'
          const text = c.line.text.replace(/\r$/, '')
          out.push(`    L${c.index}  ${tag}${text}`)
        }
      }
    }
  }
  return out.join('\n')
}
