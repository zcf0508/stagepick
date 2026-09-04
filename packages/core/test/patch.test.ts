import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/parse.js'
import { buildPatch, filterHunkLines } from '../src/patch.js'
import { resolveSelectors } from '../src/select.js'
import { parseSelector } from '../src/selector.js'

/** Parse → select everything → emit. Exercises the full round-trip. */
function selectAll(diffText: string): string {
  const diff = parseDiff(diffText)
  const sels = resolveSelectors(diff, diff.files.map(f => ({ kind: 'file' as const, path: f.path })))
  return buildPatch(diff, sels)
}

/** Parse → select by selector strings → emit. */
function selectBy(diffText: string, raw: string[]): string {
  const diff = parseDiff(diffText)
  const sels = resolveSelectors(diff, raw.map(parseSelector))
  return buildPatch(diff, sels)
}

/** First hunk id of a one-file diff. */
function firstHunkId(diffText: string): string {
  return parseDiff(diffText).files[0]!.hunks[0]!.id
}

describe('filterHunkLines', () => {
  const MIXED = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,4 +1,3 @@
 a
-b1
-b2
+B
 c
`

  it('turns unselected deletions into context and drops unselected additions', () => {
    const hunk = parseDiff(MIXED).files[0]!.hunks[0]!
    // keep only the addition (L3)
    const lines = filterHunkLines(hunk, new Set([3]))
    expect(lines.map(l => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['context', 'b1'],
      ['context', 'b2'],
      ['add', 'B'],
      ['context', 'c'],
    ])
  })

  it('keeps a selected deletion while dropping the addition', () => {
    const hunk = parseDiff(MIXED).files[0]!.hunks[0]!
    // keep only the first deletion (L1)
    const lines = filterHunkLines(hunk, new Set([1]))
    expect(lines.map(l => [l.kind, l.text])).toEqual([
      ['context', 'a'],
      ['del', 'b1'],
      ['context', 'b2'],
      ['context', 'c'],
    ])
  })

  it('keeps the no-newline marker with a deletion turned into context', () => {
    const noEol = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
`
    const hunk = parseDiff(noEol).files[0]!.hunks[0]!
    // keep only the addition: the unselected deletion becomes context and carries
    // the marker, so the index keeps the old no-newline ending.
    const lines = filterHunkLines(hunk, new Set([2]))
    expect(lines[0]).toMatchObject({ kind: 'context', text: 'a', noNewline: '\\ No newline at end of file' })
  })

  it('drops the marker together with a dropped addition', () => {
    const noEol = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
+b
\\ No newline at end of file
`
    const hunk = parseDiff(noEol).files[0]!.hunks[0]!
    // keep only the deletion: the new no-newline ending is not staged.
    const lines = filterHunkLines(hunk, new Set([1]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'del', text: 'a', noNewline: null })
  })
})

describe('planEmission', () => {
  const MIXED = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,4 +1,3 @@
 a
-b1
-b2
+B
 c
`

  it('recomputes hunk counts from the filtered lines', () => {
    // stage only the addition: the two deletions stay as context.
    const id = firstHunkId(MIXED)
    const out = selectBy(MIXED, [`${id}@L3`])
    expect(out).toContain('@@ -1,4 +1,5 @@')
  })

  it('recomputes counts for a deletion-only slice', () => {
    const id = firstHunkId(MIXED)
    const out = selectBy(MIXED, [`${id}@L1`])
    expect(out).toContain('@@ -1,4 +1,3 @@')
  })
})

// New-side anchor recomputation, ported from hunkpick (MIT) tests/renumber.rs.
// Dropping a hunk invalidates every later anchor inherited from the input;
// git apply searches from the new-side position, so a stale anchor misplaces the change.
describe('new-side anchor recomputation (ported from hunkpick)', () => {
  const INSERT_THEN_REPLACE = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -2,3 +2,4 @@
 b
+new
 c
 d
@@ -17,3 +18,3 @@
 q
-r
+R
 s
`

  it('dropping an insertion shifts the next hunk back', () => {
    const id = parseDiff(INSERT_THEN_REPLACE).files[0]!.hunks[1]!.id
    expect(selectBy(INSERT_THEN_REPLACE, [id])).toContain('@@ -17,3 +17,3 @@')
  })

  it('keeping everything reproduces the input anchors', () => {
    const out = selectAll(INSERT_THEN_REPLACE)
    expect(out).toContain('@@ -2,3 +2,4 @@')
    expect(out).toContain('@@ -17,3 +18,3 @@')
  })

  it('dropping a deletion shifts the next hunk forward', () => {
    const src = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -2,3 +2,2 @@
 b
-c
 d
@@ -17,3 +16,3 @@
 q
-r
+R
 s
`
    const id = parseDiff(src).files[0]!.hunks[1]!.id
    expect(selectBy(src, [id])).toContain('@@ -17,3 +17,3 @@')
  })

  it('zero-count sides report the preceding line', () => {
    const src = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,2 +1,0 @@
-a
-b
@@ -5,0 +4,2 @@
+x
+y
`
    const all = selectAll(src)
    expect(all).toContain('@@ -1,2 +0,0 @@')
    expect(all).toContain('@@ -5,0 +4,2 @@')
    // Dropping the deletion moves the insertion back to its old-side position.
    const insertId = parseDiff(src).files[0]!.hunks[1]!.id
    expect(selectBy(src, [insertId])).toContain('@@ -5,0 +6,2 @@')
  })

  it('an @L slice gets a recomputed anchor (ported from hunkpick new_side_anchors)', () => {
    // Take only the addition of a replacement: the unselected deletion stays as
    // context, so the slice adds one line and the anchor must come from the result.
    const src = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,6 @@
 line 1
 line 2
+inserted A
 line 3
 line 4
 line 5
@@ -17,6 +18,6 @@
 line 16
 line 17
-line 19
+LINE 19
 line 20
 line 21
 line 22
`
    const id = parseDiff(src).files[0]!.hunks[1]!.id
    const out = selectBy(src, [`${id}@L2`])
    expect(out).toContain('@@ -17,6 +17,7 @@')
  })

  it('an @L slice shifts a later hunk selected in the same patch', () => {
    // Ported from hunkpick tests/new_side_anchors.rs line_set_combined_with_a_later_subhunk_applies.
    const src = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -2,5 +2,5 @@
 line 2
-line 3
-line 4
+NEW 3
+NEW 4
 line 5
 line 6
@@ -10,4 +10,4 @@
 line 9
-line 10
+NEW 10
 line 11
 line 12
`
    const hunk1 = parseDiff(src).files[0]!.hunks[0]!.id
    const hunk2 = parseDiff(src).files[0]!.hunks[1]!.id
    // slice hunk 1 to the two additions only (L3,L4): deletions stay as context → +2 lines,
    // so hunk 2's new-side start must shift by 2.
    const out = selectBy(src, [`${hunk1}@L3,4`, hunk2])
    expect(out).toContain('@@ -2,5 +2,7 @@')
    expect(out).toContain('@@ -10,4 +12,4 @@')
  })
})

describe('emitPatch round-trip', () => {
  it('reproduces the input when everything is selected', () => {
    const src = `diff --git a/app.ts b/app.ts
index 1234567..89abcde 100644
--- a/app.ts
+++ b/app.ts
@@ -1,3 +1,3 @@ const header
 a
-b
+B
 c
@@ -10,3 +10,5 @@
 x
+y1
+y2
 z
 w
`
    expect(selectAll(src)).toBe(src)
  })

  it('reproduces a no-trailing-newline input byte-for-byte', () => {
    const src = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
+b`
    expect(selectAll(src)).toBe(src)
  })

  it('restores format-patch preamble and trailer at their positions', () => {
    const src = `From abc123 Mon Sep 17 00:00:00 2001
Subject: [PATCH] change

---
 f | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/f b/f
index 123..456 100644
--- a/f
+++ b/f
@@ -1 +1 @@
-a
+b
-- 
2.39.0
`
    expect(selectAll(src)).toBe(src)
  })

  it('reproduces CRLF line text of CRLF-tracked files', () => {
    // git writes diff structure lines with \n; only file content carries the \r.
    const src = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r'
    expect(selectAll(src)).toBe(src)
  })

  it('quotes paths with spaces when rebuilding headers', () => {
    const src = `diff --git "a/with space.txt" "b/with space.txt"
--- "a/with space.txt"
+++ "b/with space.txt"
@@ -1 +1 @@
-a
+b
`
    expect(selectAll(src)).toBe(src)
  })

  it('omits files and hunks outside the selection', () => {
    const src = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
+A
diff --git a/g b/g
--- a/g
+++ b/g
@@ -1 +1 @@
-b
+B
`
    const out = selectBy(src, [firstHunkId(src)])
    expect(out).toContain('a/f')
    expect(out).not.toContain('a/g')
  })
})
