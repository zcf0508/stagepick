import type { GitRunner } from '../src/git.js'
import { describe, expect, it } from 'vitest'
import { exitCodeOf, PartialFailureError, StagepickError, toJsonError } from '../src/errors.js'
import { GitError } from '../src/git.js'
import { parseDiff } from '../src/parse.js'
import { resolveSelectors, SelectionError } from '../src/select.js'
import { parseSelector, SelectorParseError } from '../src/selector.js'
import { createStagepick } from '../src/stagepick.js'

const ONE_HUNK = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-a
+b
`

function mockGit(overrides: Partial<GitRunner>): GitRunner {
  return {
    diff: () => '',
    applyToIndex: () => {},
    add: () => {},
    addIntentToAdd: () => {},
    untracked: () => [],
    ...overrides,
  }
}

describe('typed error codes', () => {
  it('unknown hunk id → unknown-hunk, retryable', () => {
    const error = catchError(() => resolveSelectors(parseDiff(ONE_HUNK), [{ kind: 'hunk', id: 'deadbeef', path: null }]))
    expect(error).toBeInstanceOf(SelectionError)
    expect(error.code).toBe('unknown-hunk')
    expect(error.retryable).toBe(true)
  })

  it('out-of-range @L → changed-line-out-of-range', () => {
    const diff = parseDiff(ONE_HUNK)
    const id = diff.files[0]!.hunks[0]!.id
    const error = catchError(() => resolveSelectors(diff, [{ kind: 'hunkLines', id, path: null, lines: [9] }]))
    expect(error.code).toBe('changed-line-out-of-range')
  })

  it('lines touching no change → lines-not-matched', () => {
    const error = catchError(() => resolveSelectors(parseDiff(ONE_HUNK), [{ kind: 'lines', path: 'f.ts', ranges: [[10, 12]] }]))
    expect(error.code).toBe('lines-not-matched')
  })

  it('unknown path → unknown-path', () => {
    const error = catchError(() => resolveSelectors(parseDiff(ONE_HUNK), [{ kind: 'file', path: 'nope.ts' }]))
    expect(error.code).toBe('unknown-path')
  })

  it('selector grammar → usage, not retryable', () => {
    const error = catchError(() => parseSelector('a1b2@X1'))
    expect(error).toBeInstanceOf(SelectorParseError)
    expect(error.code).toBe('usage')
    expect(error.retryable).toBe(false)
  })

  it('nothing to stage → nothing-to-stage', () => {
    const sp = createStagepick({ git: mockGit({}) })
    const error = catchError(() => sp.stage([]))
    expect(error.code).toBe('nothing-to-stage')
  })

  it('git failure → git-failed', () => {
    const error = new GitError('boom', 'stderr text', 1)
    expect(error.code).toBe('git-failed')
    expect(error.retryable).toBe(false)
  })
})

describe('exitCodeOf', () => {
  it('maps codes onto documented exit codes', () => {
    expect(exitCodeOf(catchError(() => parseSelector('')))).toBe(2)
    expect(exitCodeOf(new SelectionError('x', 'unknown-hunk'))).toBe(3)
    expect(exitCodeOf(new GitError('x', '', 1))).toBe(1)
    expect(exitCodeOf(new PartialFailureError('x', { patchApplied: true, addedUntracked: [], remainingUntracked: ['b'] }, null))).toBe(4)
    expect(exitCodeOf(new Error('unexpected'))).toBe(1)
  })
})

describe('toJsonError', () => {
  it('serializes typed errors without leaking internals', () => {
    const json = toJsonError(new SelectionError('no hunk matches id "deadbeef"', 'unknown-hunk'))
    expect(json).toEqual({
      error: {
        code: 'unknown-hunk',
        message: 'no hunk matches id "deadbeef"',
        retryable: true,
      },
    })
  })

  it('falls back to internal for unexpected errors', () => {
    const json = toJsonError(new Error('boom'))
    expect(json.error.code).toBe('internal')
    expect(json.error.retryable).toBe(false)
  })
})

describe('partial failure modeling', () => {
  it('reports exactly what landed when git add fails mid-way', () => {
    const appliedPatches: string[] = []
    const git = mockGit({
      diff: () => ONE_HUNK,
      untracked: () => ['a.ts', 'b.ts'],
      applyToIndex: (patch) => { appliedPatches.push(patch) },
      add: (paths) => {
        if (paths.includes('b.ts'))
          throw new GitError('git add failed', 'permission denied', 1)
      },
    })
    const sp = createStagepick({ git })

    const error = catchError(() => sp.stage(['f.ts', 'a.ts', 'b.ts']))
    expect(error).toBeInstanceOf(PartialFailureError)
    if (!(error instanceof PartialFailureError))
      throw new Error('expected PartialFailureError')
    expect(error.code).toBe('partial-failure')
    expect(error.retryable).toBe(false)
    // The patch was applied first (the failure-prone step goes first by design).
    expect(appliedPatches).toHaveLength(1)
    expect(error.completed).toEqual({
      patchApplied: true,
      addedUntracked: ['a.ts'],
      remainingUntracked: ['b.ts'],
    })
    expect(error.message).toContain('git reset')
    expect(exitCodeOf(error)).toBe(4)
  })
})

function catchError(fn: () => unknown): StagepickError {
  try {
    fn()
  }
  catch (error) {
    if (error instanceof StagepickError)
      return error
    throw error
  }
  throw new Error('expected the call to throw')
}
