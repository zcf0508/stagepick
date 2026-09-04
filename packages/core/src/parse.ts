import { createHash } from 'node:crypto'

/**
 * The diff data model and parser. Line text, newline markers, headers and trailer
 * lines are kept verbatim so a parsed diff renders back byte-identically
 * (round-trip property), the same contract hunkpick (MIT) gives its `emit`.
 */

export interface DiffLine {
  kind: 'context' | 'add' | 'del'
  /** Line content without the leading +/-/space tag. May carry a trailing \r for CRLF files. */
  text: string
  /** 1-based line number in the old file. null for additions. */
  oldLine: number | null
  /** 1-based line number in the new file. null for deletions. */
  newLine: number | null
  /** Verbatim `\ No newline at end of file` marker following this line (without trailing \n), or null. */
  noNewline: string | null
}

export interface Hunk {
  /** Content-addressed id: stable across re-diffs as long as the changed (+/-) lines stay identical. */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Text after the second @@ (function/section heading), may be empty. */
  section: string
  lines: DiffLine[]
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary' | 'untracked'

export interface TrailerLine {
  /** Number of hunks of this file emitted before this line. */
  afterHunk: number
  text: string
}

export interface FileDiff {
  /** Display path: newPath, falling back to oldPath. */
  path: string
  oldPath: string | null
  newPath: string | null
  status: FileStatus
  /** Extended header lines (index/mode/rename/similarity), verbatim, without the ---/+++ lines. */
  headers: string[]
  /**
   * Lines that follow a hunk body rather than precede the first hunk: blank separators
   * between hunks, a `git format-patch` signature, trailing junk. Emitted at the position
   * keyed by afterHunk, never ahead of the first hunk (git apply rejects that as garbage).
   */
  trailer: TrailerLine[]
  hunks: Hunk[]
}

export interface ParsedDiff {
  /** Raw lines before the first `diff --git` (mail headers of git format-patch output, etc.). */
  preamble: string[]
  files: FileDiff[]
  /** True when the input's last line had no line ending. */
  noTrailingNewline: boolean
}

export function computeHunkId(path: string, lines: DiffLine[]): string {
  const hash = createHash('sha256')
  hash.update(path)
  hash.update('\0')
  for (const line of lines) {
    if (line.kind === 'context')
      continue
    hash.update(line.kind === 'add' ? '+' : '-')
    hash.update(line.text)
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 8)
}

/** Changed (+/-) lines of a hunk in body order with their 1-based index (deletions and additions share one numbering). */
export function changedLines(hunk: Hunk): Array<{ index: number, line: DiffLine, lineIndex: number }> {
  const out: Array<{ index: number, line: DiffLine, lineIndex: number }> = []
  let n = 0
  hunk.lines.forEach((line, lineIndex) => {
    if (line.kind !== 'context')
      out.push({ index: ++n, line, lineIndex })
  })
  return out
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function unquoteCStyle(p: string): string {
  if (!p.startsWith('"'))
    return p
  let out = ''
  for (let i = 1; i < p.length; i++) {
    const ch = p[i]
    if (ch === '"')
      break
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = p[++i]
    if (next === undefined)
      break
    if (next === 'n') {
      out += '\n'
    }
    else if (next === 't') {
      out += '\t'
    }
    else if (next === '\\') {
      out += '\\'
    }
    else if (next === '"') {
      out += '"'
    }
    else if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3) {
        const d = p[i + 1]
        if (d !== undefined && d >= '0' && d <= '7') {
          oct += d
          i++
        }
        else {
          break
        }
      }
      out += String.fromCharCode(Number.parseInt(oct, 8))
    }
    else {
      out += next
    }
  }
  return out
}

/** Quote a path for the diff --git / --- / +++ lines when it needs C-style quoting. */
export function quotePath(p: string): string {
  // git quotes paths containing spaces, control characters, " or \.
  // Non-ASCII bytes are emitted raw because we always run git with -c core.quotepath=false.
  // eslint-disable-next-line no-control-regex
  if (!/[ \x00-\x1F"\\\x7F]/.test(p))
    return p
  let out = '"'
  for (const ch of p) {
    if (ch === '"' || ch === '\\')
      out += `\\${ch}`
    else if (ch === '\n')
      out += '\\n'
    else if (ch === '\t')
      out += '\\t'
    else
      out += ch
  }
  return `${out}"`
}

function parseMarkerPath(line: string): string | null {
  const raw = line.slice(4)
  if (raw === '/dev/null')
    return null
  const unquoted = unquoteCStyle(raw)
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/'))
    return unquoted.slice(2)
  return unquoted
}

function parseHunk(lines: string[], start: number, path: string): { hunk: Hunk, next: number } {
  const header = lines[start]!
  const m = HUNK_HEADER_RE.exec(header)
  if (!m)
    throw new Error(`malformed hunk header: ${header}`)
  const oldStart = Number(m[1])
  const oldLines = m[2] === undefined ? 1 : Number(m[2])
  const newStart = Number(m[3])
  const newLines = m[4] === undefined ? 1 : Number(m[4])
  const section = (m[5] ?? '').trim()

  const hunkLines: DiffLine[] = []
  let i = start + 1
  let oldLeft = oldLines
  let newLeft = newLines
  let oldLine = oldStart
  let newLine = newStart

  while (i < lines.length) {
    const raw = lines[i]!
    const tag = raw[0]
    // The `\ No newline at end of file` marker is not counted by the hunk header;
    // it can also appear after the line that completed the declared counts.
    if (tag === '\\') {
      const prev = hunkLines[hunkLines.length - 1]
      if (prev)
        prev.noNewline = raw
      i++
      continue
    }
    if (oldLeft <= 0 && newLeft <= 0)
      break
    if (tag === ' ' || raw === '') {
      // A context line for an empty source line is a lone space; mail clients and paste
      // buffers routinely strip it. Treat a truly empty line as an empty context line.
      hunkLines.push({ kind: 'context', text: raw === '' ? '' : raw.slice(1), oldLine: oldLine++, newLine: newLine++, noNewline: null })
      oldLeft--
      newLeft--
    }
    else if (tag === '-') {
      hunkLines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null, noNewline: null })
      oldLeft--
    }
    else if (tag === '+') {
      hunkLines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++, noNewline: null })
      newLeft--
    }
    else {
      // Unexpected line inside a hunk body; stop consuming and let the caller re-sync.
      break
    }
    i++
  }

  const hunk: Hunk = {
    id: computeHunkId(path, hunkLines),
    oldStart,
    oldLines,
    newStart,
    newLines,
    section,
    lines: hunkLines,
  }
  return { hunk, next: i }
}

function splitGitLinePaths(gitLine: string): [string | null, string | null] {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(gitLine)
  if (!m)
    return [null, null]
  return [unquoteCStyle(m[1]!), unquoteCStyle(m[2]!)]
}

function parseFile(lines: string[], start: number): { file: FileDiff, next: number } {
  const gitLine = lines[start]!
  let i = start + 1
  const headers: string[] = []
  let oldPath: string | null = null
  let newPath: string | null = null
  let sawOldMarker = false
  let sawNewMarker = false
  let isNew = false
  let isDeleted = false
  let isRename = false
  let isBinary = false

  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('diff --git ') || line.startsWith('@@ '))
      break
    if (line.startsWith('--- ')) {
      oldPath = parseMarkerPath(line)
      sawOldMarker = true
      i++
      continue
    }
    if (line.startsWith('+++ ')) {
      newPath = parseMarkerPath(line)
      sawNewMarker = true
      i++
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      isBinary = true
      headers.push(line)
      i++
      continue
    }
    if (line.startsWith('new file mode'))
      isNew = true
    else if (line.startsWith('deleted file mode'))
      isDeleted = true
    else if (line.startsWith('rename from ') || line.startsWith('rename to '))
      isRename = true
    headers.push(line)
    i++
  }

  if (!sawOldMarker && !sawNewMarker) {
    // Pure mode change / rename without content, or a binary entry: take paths from the
    // `diff --git a/x b/y` line (unreliable with spaces, but there is no better source here).
    ;[oldPath, newPath] = splitGitLinePaths(gitLine)
  }

  const path = newPath ?? oldPath ?? 'unknown'
  const hunks: Hunk[] = []
  const trailer: TrailerLine[] = []
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('diff --git '))
      break
    if (line.startsWith('@@ ')) {
      const { hunk, next } = parseHunk(lines, i, path)
      hunks.push(hunk)
      i = next
      continue
    }
    // Blank separators between hunks, `git format-patch` signatures, binary patch payloads.
    trailer.push({ afterHunk: hunks.length, text: line })
    i++
  }

  const status: FileStatus = isBinary
    ? 'binary'
    : isNew
      ? 'added'
      : isDeleted
        ? 'deleted'
        : isRename
          ? 'renamed'
          : 'modified'

  return { file: { path, oldPath, newPath, status, headers, trailer, hunks }, next: i }
}

export function parseDiff(input: string): ParsedDiff {
  const noTrailingNewline = input.length > 0 && !input.endsWith('\n')
  const lines = input.split('\n')
  // The final empty element produced by a trailing newline is not a real line.
  if (!noTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '')
    lines.pop()

  const files: FileDiff[] = []
  const preamble: string[] = []
  let i = 0
  let seenFirstFile = false
  while (i < lines.length) {
    if (lines[i]!.startsWith('diff --git ')) {
      seenFirstFile = true
      const { file, next } = parseFile(lines, i)
      files.push(file)
      i = next
    }
    else {
      if (!seenFirstFile)
        preamble.push(lines[i]!)
      i++
    }
  }
  return { preamble, files, noTrailingNewline }
}
