import type { TestRepo } from './helpers/repo.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStagepick, SelectionError } from '../src/index.js'
import { anchorFixture, createRepo } from './helpers/repo.js'

let repo: TestRepo

beforeEach(() => {
  repo = createRepo({ 'f.txt': anchorFixture().before })
})
afterEach(() => {
  repo.cleanup()
})

describe('stage by hunk id', () => {
  it('stages exactly one hunk of a two-hunk file', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })
    const diff = sp.list()
    const [hunk1, hunk2] = diff.files[0]!.hunks

    const result = sp.stage([hunk2!.id])
    expect(result.hunks).toBe(1)
    expect(result.files).toBe(1)

    const staged = repo.diffStaged()
    expect(staged).toContain('+LINE 20')
    expect(staged).not.toContain('+inserted A')

    const remaining = repo.diff()
    expect(remaining).toContain('+inserted A')
    expect(remaining).not.toContain('+LINE 20')
    expect(hunk1).toBeDefined()
  })

  it('keeps hunk ids stable while staging other hunks (loop staging)', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })
    const diff = sp.list()
    const [hunk1, hunk2] = diff.files[0]!.hunks

    sp.stage([hunk1!.id])
    // The id captured before staging hunk 1 must still resolve hunk 2.
    sp.stage([hunk2!.id])

    const staged = repo.diffStaged()
    expect(staged).toContain('+inserted A')
    expect(staged).toContain('+LINE 20')
    expect(repo.diff()).toBe('')
  })
})

describe('stage by file line ranges', () => {
  it('stages the change run touching the given new-file lines', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })

    sp.stage(['f.txt:4']) // the +inserted A line (new-file line 4)
    expect(repo.diffStaged()).toContain('+inserted A')
    expect(repo.diff()).toContain('+LINE 20')
  })

  it('rejects ranges touching no change with a helpful error', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })
    expect(() => sp.stage(['f.txt:10-12'])).toThrow(SelectionError)
    expect(() => sp.stage(['f.txt:10-12'])).toThrow(/do not touch any change/)
  })
})

describe('stage individual changed lines (@L)', () => {
  it('splits a replacement into a deletion commit and an addition commit', () => {
    repo = createRepo({ 'f.txt': 'a\nb\nc\n' })
    repo.write('f.txt', 'a\nB\nc\n')
    const sp = createStagepick({ cwd: repo.dir })
    const id = sp.list().files[0]!.hunks[0]!.id

    // Round 1: stage only the deletion (L1).
    sp.stage([`${id}@L1`])
    let staged = repo.diffStaged()
    expect(staged).toContain('-b')
    expect(staged).not.toContain('+B')

    // Round 2: the remaining diff is the pure addition; stage it.
    const id2 = sp.list().files[0]!.hunks[0]!.id
    sp.stage([`${id2}@L1`])
    staged = repo.diffStaged()
    expect(staged).toContain('-b')
    expect(staged).toContain('+B')
    expect(repo.diff()).toBe('')
  })
})

describe('unstage', () => {
  it('reverses a staged hunk out of the index', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })
    const [hunk1] = sp.list().files[0]!.hunks
    sp.stage([hunk1!.id])
    expect(repo.diffStaged()).toContain('+inserted A')

    const stagedId = sp.list({ staged: true }).files[0]!.hunks[0]!.id
    sp.unstage([stagedId])
    expect(repo.diffStaged()).toBe('')
    expect(repo.diff()).toContain('+inserted A')
  })
})

describe('untracked files', () => {
  it('stages an untracked file whole', () => {
    repo.write('new.ts', 'line1\nline2\n')
    const sp = createStagepick({ cwd: repo.dir })
    const result = sp.stage(['new.ts'])
    expect(result.addedUntracked).toEqual(['new.ts'])
    expect(repo.diffStaged()).toContain('new.ts')
  })

  it('supports line selectors on untracked files via intent-to-add', () => {
    repo.write('new.ts', 'line1\nline2\nline3\n')
    const sp = createStagepick({ cwd: repo.dir })
    // A new file is a single change run; any line in range selects the run.
    sp.stage(['new.ts:2'])
    const staged = repo.diffStaged()
    expect(staged).toContain('new.ts')
    expect(staged).toContain('+line2')
  })

  it('lists untracked files as hunks-less entries', () => {
    repo.write('new.ts', 'x\n')
    const sp = createStagepick({ cwd: repo.dir })
    const diff = sp.list()
    const entry = diff.files.find(f => f.path === 'new.ts')
    expect(entry).toMatchObject({ status: 'untracked', hunks: [] })
  })
})

describe('dry run', () => {
  it('returns the patch without touching the index', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })
    const [hunk1] = sp.list().files[0]!.hunks
    const result = sp.stage([hunk1!.id], { dryRun: true })
    expect(result.patch).toContain('+inserted A')
    expect(result.dryRun).toBe(true)
    expect(repo.diffStaged()).toBe('')
  })
})

describe('utf-8 content', () => {
  it('splits two CJK edits sharing one hunk via a line selector', () => {
    // Edits two lines apart land in a single hunk; a hunk-id stage would take both,
    // a line selector takes exactly the run it touches.
    repo = createRepo({ 'app.ts': 'const a = \'原始内容 1\'\nconst b = \'原始内容 2\'\nconst c = \'原始内容 3\'\n' })
    repo.write('app.ts', 'const a = \'修复登录bug\'\nconst b = \'原始内容 2\'\nconst c = \'新增缓存逻辑\'\n')
    const sp = createStagepick({ cwd: repo.dir })
    expect(sp.list().files[0]!.hunks).toHaveLength(1)
    sp.stage(['app.ts:1'])
    const staged = repo.diffStaged()
    expect(staged).toContain('修复登录bug')
    expect(staged).not.toContain('新增缓存逻辑')
  })
})

// Ported from hunkpick (MIT) tests/new_side_anchors.rs:
// with duplicated context, a stale new-side anchor would make git apply
// edit the wrong copy. Recomputed anchors land the change in the right one.
describe('duplicated context safety (ported from hunkpick)', () => {
  it('applies to the second copy, not the first', () => {
    const block = 'b\nc\nBLK1\nBLK2\nBLK3\nBLK4\n'
    const before = `head\n${Array.from({ length: 10 }, (_, i) => `d${i + 1}`).join('\n')}\n${block}${block}`
    const after = `head\n${block}b\nc\nBLK1\nCHANGED\nBLK3\nBLK4\n`
    repo = createRepo({ 'f.txt': before })
    repo.write('f.txt', after)

    const sp = createStagepick({ cwd: repo.dir })
    const hunks = sp.list().files[0]!.hunks
    expect(hunks).toHaveLength(2)

    // Stage only the second hunk (the BLK2→CHANGED edit in the second copy).
    sp.stage([hunks[1]!.id])

    const staged = repo.diffStaged()
    expect(staged).toContain('+CHANGED')
    // The staged hunk must sit at the second copy's position (old line 18+),
    // not drift to the first copy right after "head".
    expect(staged).toMatch(/@@ -18,\d+ \+18,\d+ @@/)
  })
})

describe('cRLF line endings', () => {
  it('stages a trailing CRLF line byte-exactly (regression: final \\r must survive)', () => {
    // execa's default stripFinalNewline ate the \r of the diff's last line,
    // leaving the index LF-ended while the worktree was CRLF-ended.
    repo = createRepo({ 'f.txt': 'a' })
    repo.write('f.txt', 'a\r\nb\r\n')
    const sp = createStagepick({ cwd: repo.dir })
    sp.stage(['f.txt'])
    expect(repo.diff()).toBe('')
    expect(repo.diffStaged()).toContain('+b')
  })

  it('stages a subset of a CRLF file without corrupting line endings', () => {
    repo = createRepo({ 'f.txt': 'a\r\nb\r\nc\r\nd\r\ne\r\n' })
    repo.write('f.txt', 'a\r\nB\r\nc\r\nD\r\ne\r\n')
    const sp = createStagepick({ cwd: repo.dir })
    // Both edits share one hunk; select only the first run by line number.
    sp.stage(['f.txt:2'])
    const staged = repo.diffStaged()
    expect(staged).toContain('+B')
    expect(staged).not.toContain('+D')
    // Stage the remainder: after both rounds the index must equal the worktree
    // byte-for-byte — no \r lost anywhere.
    sp.stage(['f.txt'])
    expect(repo.diff()).toBe('')
  })
})

describe('error cases', () => {
  it('throws when there is nothing to stage', () => {
    const sp = createStagepick({ cwd: repo.dir })
    expect(() => sp.stage(['f.txt'])).toThrow(SelectionError)
  })

  it('throws for unknown hunk ids', () => {
    repo.write('f.txt', anchorFixture().after)
    const sp = createStagepick({ cwd: repo.dir })
    expect(() => sp.stage(['deadbeef'])).toThrow(/no hunk matches id/)
  })
})
