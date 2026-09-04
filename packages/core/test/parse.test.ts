import { describe, expect, it } from 'vitest'
import { changedLines, parseDiff, quotePath } from '../src/parse.js'

describe('parseDiff', () => {
  it('parses a single-hunk single-file diff', () => {
    const diff = `diff --git a/app.ts b/app.ts
index 1234567..89abcde 100644
--- a/app.ts
+++ b/app.ts
@@ -1,3 +1,3 @@ const header
 a
-b
+B
 c
`
    const { files, preamble, noTrailingNewline } = parseDiff(diff)
    expect(preamble).toEqual([])
    expect(noTrailingNewline).toBe(false)
    expect(files).toHaveLength(1)

    const file = files[0]!
    expect(file.path).toBe('app.ts')
    expect(file.oldPath).toBe('app.ts')
    expect(file.newPath).toBe('app.ts')
    expect(file.status).toBe('modified')
    expect(file.headers).toEqual(['index 1234567..89abcde 100644'])

    const hunk = file.hunks[0]!
    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldLines).toBe(3)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newLines).toBe(3)
    expect(hunk.section).toBe('const header')
    expect(hunk.id).toMatch(/^[0-9a-f]{8}$/)
    expect(hunk.lines.map(l => [l.kind, l.text, l.oldLine, l.newLine])).toEqual([
      ['context', 'a', 1, 1],
      ['del', 'b', 2, null],
      ['add', 'B', null, 2],
      ['context', 'c', 3, 3],
    ])
  })

  it('numbers changed lines across del/add in body order', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,3 +1,4 @@
-a
-b
+B1
+B2
 c
`
    const [file] = parseDiff(diff).files
    expect(changedLines(file!.hunks[0]!).map(c => [c.index, c.line.kind])).toEqual([
      [1, 'del'],
      [2, 'del'],
      [3, 'add'],
      [4, 'add'],
    ])
  })

  it('defaults omitted hunk counts to 1', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
+b
`
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    expect([hunk.oldLines, hunk.newLines]).toEqual([1, 1])
  })

  it('keeps utf-8 content verbatim', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-const line8 = '原始内容 8'
+const line8 = '修复登录bug'
`
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    expect(hunk.lines[0]!.text).toBe('const line8 = \'原始内容 8\'')
    expect(hunk.lines[1]!.text).toBe('const line8 = \'修复登录bug\'')
  })

  it('preserves trailing \\r of CRLF-tracked files inside line text', () => {
    // git writes diff structure lines with \n; only file content carries the \r.
    const diff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r'
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    expect(hunk.lines.map(l => l.text)).toEqual(['a\r', 'b\r', 'B\r', 'c\r'])
  })

  it('attaches no-newline markers verbatim to the preceding line', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    expect(hunk.lines[0]!.noNewline).toBe('\\ No newline at end of file')
    expect(hunk.lines[1]!.noNewline).toBe('\\ No newline at end of file')
  })

  it('parses a new-file diff (/dev/null old side)', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+a
+b
`
    const file = parseDiff(diff).files[0]!
    expect(file.status).toBe('added')
    expect(file.oldPath).toBeNull()
    expect(file.newPath).toBe('new.txt')
    expect(file.path).toBe('new.txt')
  })

  it('parses a deleted-file diff (/dev/null new side)', () => {
    const diff = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1234567..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`
    const file = parseDiff(diff).files[0]!
    expect(file.status).toBe('deleted')
    expect(file.oldPath).toBe('old.txt')
    expect(file.newPath).toBeNull()
    expect(file.path).toBe('old.txt')
  })

  it('keeps rename and mode extended headers verbatim', () => {
    const diff = `diff --git a/old.txt b/new.txt
similarity index 83%
rename from old.txt
rename to new.txt
index 1234567..89abcde 100644
--- a/old.txt
+++ b/new.txt
@@ -5,3 +5,3 @@
 ctx
-old
+new
 ctx
`
    const file = parseDiff(diff).files[0]!
    expect(file.status).toBe('renamed')
    expect(file.headers).toEqual([
      'similarity index 83%',
      'rename from old.txt',
      'rename to new.txt',
      'index 1234567..89abcde 100644',
    ])
    expect(file.oldPath).toBe('old.txt')
    expect(file.newPath).toBe('new.txt')
  })

  it('keeps mode-change headers', () => {
    const diff = `diff --git a/f.sh b/f.sh
old mode 100644
new mode 100755
index 1234567..89abcde
--- a/f.sh
+++ b/f.sh
@@ -1 +1 @@
-a
+b
`
    const file = parseDiff(diff).files[0]!
    expect(file.headers).toContain('old mode 100644')
    expect(file.headers).toContain('new mode 100755')
  })

  it('marks binary files with zero hunks', () => {
    const diff = `diff --git a/f.bin b/f.bin
index 1234567..89abcde 100644
Binary files a/f.bin and b/f.bin differ
`
    const file = parseDiff(diff).files[0]!
    expect(file.status).toBe('binary')
    expect(file.hunks).toEqual([])
  })

  it('parses multiple files and multiple hunks', () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+A
@@ -10 +10 @@
-b
+B
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-c
+C
`
    const { files } = parseDiff(diff)
    expect(files.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(files[0]!.hunks).toHaveLength(2)
    expect(files[1]!.hunks).toHaveLength(1)
    // hunk ids differ between files and between hunks
    const ids = files.flatMap(f => f.hunks.map(h => h.id))
    expect(new Set(ids).size).toBe(3)
  })

  it('treats a stripped empty context line as an empty context line', () => {
    // Mail clients and paste buffers strip the lone-space marker of empty context lines.
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,3 +1,4 @@
 a

-x
+X
 b
`
    const hunk = parseDiff(diff).files[0]!.hunks[0]!
    expect(hunk.lines.map(l => l.kind)).toEqual(['context', 'context', 'del', 'add', 'context'])
    expect(hunk.lines[1]!.text).toBe('')
  })

  it('collects preamble and format-patch trailer lines', () => {
    const diff = `From abc123 Mon Sep 17 00:00:00 2001
From: A <a@b.c>
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
    const { files, preamble } = parseDiff(diff)
    expect(preamble.length).toBeGreaterThan(0)
    expect(preamble[0]).toBe('From abc123 Mon Sep 17 00:00:00 2001')
    expect(files[0]!.trailer.map(t => t.text)).toEqual(['-- ', '2.39.0', ''])
    expect(files[0]!.trailer[0]!.afterHunk).toBe(1)
  })

  it('detects a missing trailing newline at end of input', () => {
    const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1 +1 @@
-a
+b`
    expect(parseDiff(diff).noTrailingNewline).toBe(true)
    expect(parseDiff(`${diff}\n`).noTrailingNewline).toBe(false)
  })

  it('decodes C-quoted paths', () => {
    const diff = `diff --git "a/path with space.txt" "b/path with space.txt"
--- "a/path with space.txt"
+++ "b/path with space.txt"
@@ -1 +1 @@
-a
+b
`
    expect(parseDiff(diff).files[0]!.path).toBe('path with space.txt')
  })

  it('returns an empty file list for empty input', () => {
    expect(parseDiff('').files).toEqual([])
    expect(parseDiff('\n').files).toEqual([])
  })
})

describe('quotePath', () => {
  it('leaves ordinary paths unquoted', () => {
    expect(quotePath('src/app.ts')).toBe('src/app.ts')
    expect(quotePath('中文/文件.ts')).toBe('中文/文件.ts')
  })

  it('quotes paths with control characters or quotes', () => {
    expect(quotePath('with"quote')).toBe('"with\\"quote"')
    expect(quotePath('with\\backslash')).toBe('"with\\\\backslash"')
  })
})
