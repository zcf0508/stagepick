import { describe, expect, it } from 'vitest'
import { changedLines, parseDiff } from '../src/parse.js'
import { changeRuns, resolveSelectors, SelectionError } from '../src/select.js'
import { parseSelector } from '../src/selector.js'

const TWO_HUNKS = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1,5 +1,6 @@
 line 1
 line 2
+inserted A
 line 3
 line 4
 line 5
@@ -17,6 +18,6 @@
 line 17
 line 18
-line 19
+LINE 19
 line 20
 line 21
 line 22
`

function resolve(diffText: string, raw: string[]) {
  const diff = parseDiff(diffText)
  return resolveSelectors(diff, raw.map(parseSelector))
}

describe('changeRuns', () => {
  it('splits runs at context lines and tracks new-side spans', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,6 +1,5 @@
 a
-b1
-b2
+B
 c
-d
+D
 e
`
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    const runs = changeRuns(hunk)
    expect(runs).toHaveLength(2)
    expect(runs[0]!.indices).toEqual([1, 2, 3])
    expect([runs[0]!.newStart, runs[0]!.newEnd]).toEqual([2, 2])
    expect(runs[1]!.indices).toEqual([4, 5])
    expect([runs[1]!.newStart, runs[1]!.newEnd]).toEqual([4, 4])
  })

  it('anchors a pure deletion at the new-file line it sits before', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,4 +1,2 @@
 a
-b
-c
 d
`
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    const [run] = changeRuns(hunk)
    expect(run!.indices).toEqual([1, 2])
    expect([run!.newStart, run!.newEnd]).toEqual([2, 2])
  })
})

describe('resolveSelectors', () => {
  it('selects a whole hunk by id', () => {
    const diff = parseDiff(TWO_HUNKS)
    const id = diff.files[0]!.hunks[1]!.id
    const sel = resolveSelectors(diff, [{ kind: 'hunk', id, path: null }])
    expect(sel).toHaveLength(1)
    expect(sel[0]!.hunks).toHaveLength(1)
    expect([...sel[0]!.hunks[0]!.selected]).toEqual([1, 2])
  })

  it('prefix-matches hunk ids', () => {
    const diff = parseDiff(TWO_HUNKS)
    const id = diff.files[0]!.hunks[0]!.id
    const sel = resolveSelectors(diff, [{ kind: 'hunk', id: id.slice(0, 4), path: null }])
    expect(sel[0]!.hunks[0]!.hunk.id).toBe(id)
  })

  it('rejects an unknown id with guidance to re-list', () => {
    expect(() => resolve(TWO_HUNKS, ['deadbeef'])).toThrow(SelectionError)
    expect(() => resolve(TWO_HUNKS, ['deadbeef'])).toThrow(/re-run `stagepick list`/)
  })

  it('selects every hunk sharing one content id (identical edits)', () => {
    const diff = parseDiff(TWO_HUNKS)
    // Forge a collision (the real-world case: the same edit twice in one file).
    const [file] = diff.files
    file!.hunks[1]!.id = file!.hunks[0]!.id
    const sel = resolveSelectors(diff, [{ kind: 'hunk', id: file!.hunks[0]!.id, path: null }])
    expect(sel[0]!.hunks).toHaveLength(2)
    const restricted = resolveSelectors(diff, [{ kind: 'hunk', id: file!.hunks[0]!.id, path: 'f.ts' }])
    expect(restricted[0]!.hunks).toHaveLength(2)
  })

  it('selects individual changed lines via @L', () => {
    const diff = parseDiff(TWO_HUNKS)
    const id = diff.files[0]!.hunks[1]!.id
    const sel = resolveSelectors(diff, [{ kind: 'hunkLines', id, path: null, lines: [2] }])
    expect([...sel[0]!.hunks[0]!.selected]).toEqual([2])
  })

  it('rejects out-of-range @L numbers', () => {
    const diff = parseDiff(TWO_HUNKS)
    const id = diff.files[0]!.hunks[1]!.id
    expect(() => resolveSelectors(diff, [{ kind: 'hunkLines', id, path: null, lines: [3] }]))
      .toThrow(/out of range 1\.\.2/)
  })

  it('selects change runs by new-file line ranges', () => {
    const diff = parseDiff(TWO_HUNKS)
    const sel = resolveSelectors(diff, [{ kind: 'lines', path: 'f.ts', ranges: [[3, 3]] }])
    expect(sel[0]!.hunks[0]!.hunk).toBe(diff.files[0]!.hunks[0]!)
    expect([...sel[0]!.hunks[0]!.selected]).toEqual([1])
  })

  it('selects the replacement run when the range touches any of its lines', () => {
    const diff = parseDiff(TWO_HUNKS)
    const sel = resolveSelectors(diff, [{ kind: 'lines', path: 'f.ts', ranges: [[20, 20]] }])
    // replacement run = del(L1) + add(L2), staged atomically
    expect([...sel[0]!.hunks[0]!.selected].sort()).toEqual([1, 2])
  })

  it('rejects line ranges that touch no change', () => {
    expect(() => resolve(TWO_HUNKS, ['f.ts:10-12']))
      .toThrow(/do not touch any change/)
  })

  it('selects a whole file by path (expands to all hunks, fully selected)', () => {
    const diff = parseDiff(TWO_HUNKS)
    const sel = resolveSelectors(diff, [{ kind: 'file', path: 'f.ts' }])
    expect(sel[0]!.wholeFile).toBe(false)
    expect(sel[0]!.hunks).toHaveLength(2)
    expect([...sel[0]!.hunks[0]!.selected]).toEqual([1])
    expect([...sel[0]!.hunks[1]!.selected]).toEqual([1, 2])
  })

  it('falls back to a whole-file selection when an id-shaped token matches no hunk', () => {
    const diff = parseDiff(`diff --git a/deadbee b/deadbee
--- a/deadbee
+++ b/deadbee
@@ -1 +1 @@
-a
+b
`)
    const sel = resolveSelectors(diff, [{ kind: 'hunk', id: 'deadbee', path: null }])
    expect(sel[0]!.file.path).toBe('deadbee')
    expect(sel[0]!.hunks).toHaveLength(1)
  })

  it('rejects unknown paths', () => {
    expect(() => resolve(TWO_HUNKS, ['nope.ts']))
      .toThrow(/no changes found for path/)
  })

  it('merges selectors across files', () => {
    const multi = `${TWO_HUNKS}diff --git a/g.ts b/g.ts
--- a/g.ts
+++ b/g.ts
@@ -1 +1 @@
-a
+b
`
    const diff = parseDiff(multi)
    const sels = resolveSelectors(diff, [
      { kind: 'lines', path: 'f.ts', ranges: [[3, 3]] },
      { kind: 'file', path: 'g.ts' },
    ])
    expect(sels).toHaveLength(2)
  })
})

describe('changedLines', () => {
  it('shares one numbering between deletions and additions', () => {
    const diff = parseDiff(TWO_HUNKS)
    const hunk = diff.files[0]!.hunks[1]!
    expect(changedLines(hunk).map(c => [c.index, c.line.kind, c.line.text])).toEqual([
      [1, 'del', 'line 19'],
      [2, 'add', 'LINE 19'],
    ])
  })
})
