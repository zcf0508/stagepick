/**
 * Selector grammar (one per CLI argument):
 *
 *   path                    whole file
 *   deadbeef                hunk by content id (4-40 hex chars; add ./ prefix to force a file path)
 *   path#deadbeef           hunk by id, restricted to one file
 *   path:42-45,50           new-file line ranges — selects whole change runs touching those lines
 *   deadbeef@L1,3-5         individual changed (+/-) lines of a hunk (numbering from `list --json`)
 *   path#deadbeef@L2        same, restricted to one file
 */
export type Selector
  = | { kind: 'file', path: string }
    | { kind: 'hunk', id: string, path: string | null }
    | { kind: 'lines', path: string, ranges: Array<[number, number]> }
    | { kind: 'hunkLines', id: string, path: string | null, lines: number[] }

export class SelectorParseError extends Error {
  override readonly name = 'SelectorParseError'
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message)
  }
}

const HUNK_ID_RE = /^[0-9a-f]{4,40}$/i
const LINE_SUFFIX_RE = /^(.*?):(\d[\d,\-]*)$/

export function isHunkId(value: string): boolean {
  return HUNK_ID_RE.test(value)
}

/** Parse `1,3-5` into a sorted, deduplicated list of 1-based numbers. */
export function parseNumberSet(raw: string): number[] {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    if (part === '')
      throw new SelectorParseError(`empty element in set "${raw}"`, raw)
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m)
      throw new SelectorParseError(`invalid range "${part}" in set "${raw}"`, raw)
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (lo < 1 || hi < lo)
      throw new SelectorParseError(`invalid range "${part}" in set "${raw}"`, raw)
    for (let n = lo; n <= hi; n++) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/** Parse `42-45,50` into normalized (sorted, merged not required) ranges. */
export function parseRanges(raw: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const part of raw.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m)
      throw new SelectorParseError(`invalid range "${part}"`, raw)
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (lo < 1 || hi < lo)
      throw new SelectorParseError(`invalid range "${part}"`, raw)
    ranges.push([lo, hi])
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

function splitHunkRef(raw: string): { id: string, path: string | null } {
  const hash = raw.indexOf('#')
  if (hash === -1) {
    if (!isHunkId(raw))
      throw new SelectorParseError(`"${raw}" is not a hunk id (expected 4-40 hex chars)`, raw)
    return { id: raw.toLowerCase(), path: null }
  }
  const path = raw.slice(0, hash)
  const id = raw.slice(hash + 1)
  if (path === '' || !isHunkId(id))
    throw new SelectorParseError(`invalid hunk reference "${raw}" (expected path#id)`, raw)
  return { id: id.toLowerCase(), path }
}

export function parseSelector(raw: string): Selector {
  if (raw === '')
    throw new SelectorParseError('empty selector', raw)

  const at = raw.indexOf('@')
  if (at !== -1) {
    const head = raw.slice(0, at)
    const spec = raw.slice(at + 1)
    if (!/^L/i.test(spec))
      throw new SelectorParseError(`invalid line spec "@${spec}" in "${raw}" (expected @L1,3-5)`, raw)
    const { id, path } = splitHunkRef(head)
    return { kind: 'hunkLines', id, path, lines: parseNumberSet(spec.slice(1)) }
  }

  if (raw.includes('#')) {
    const { id, path } = splitHunkRef(raw)
    return { kind: 'hunk', id, path }
  }

  const lineMatch = LINE_SUFFIX_RE.exec(raw)
  const linePath = lineMatch?.[1]
  const lineSpec = lineMatch?.[2]
  if (linePath && lineSpec) {
    // git paths are repo-relative and POSIX-style; a drive-letter-like tail is not supported.
    if (lineSpec.includes('-'))
      return { kind: 'lines', path: linePath, ranges: parseRanges(lineSpec) }
    if (/^\d+$/.test(lineSpec))
      return { kind: 'lines', path: linePath, ranges: parseRanges(lineSpec) }
  }

  if (isHunkId(raw))
    return { kind: 'hunk', id: raw.toLowerCase(), path: null }

  return { kind: 'file', path: raw.startsWith('./') ? raw.slice(2) : raw }
}
