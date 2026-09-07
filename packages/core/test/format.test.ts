import type { TestRepo } from './helpers/repo.js'
import { decode, encode } from '@toon-format/toon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStagepick, formatJson, formatToon, toJsonModel } from '../src/index.js'
import { anchorFixture, createRepo } from './helpers/repo.js'

let repo: TestRepo

beforeEach(() => {
  repo = createRepo({ 'f.txt': anchorFixture().before })
  repo.write('f.txt', anchorFixture().after)
})
afterEach(() => {
  repo.cleanup()
})

describe('formatToon', () => {
  it('encodes the same model as formatJson, losslessly', () => {
    const diff = createStagepick({ cwd: repo.dir }).list()
    const toon = formatToon(diff)
    expect(decode(toon)).toEqual(toJsonModel(diff))
    expect(decode(toon)).toEqual(JSON.parse(formatJson(diff)))
  })

  it('declares array lengths and tabular changedLines field lists', () => {
    const diff = createStagepick({ cwd: repo.dir }).list()
    const toon = formatToon(diff)
    expect(toon).toMatch(/files\[1\]:/)
    expect(toon).toMatch(/hunks\[2\]:/)
    expect(toon).toMatch(/changedLines\[2\]\{i,kind,text,oldLine,newLine\}:/)
  })

  it('uses fewer tokens than pretty JSON for a realistic diff', () => {
    const diff = createStagepick({ cwd: repo.dir }).list()
    expect(formatToon(diff).length).toBeLessThan(formatJson(diff).length)
  })

  it('encodes an empty diff', () => {
    const clean = createRepo({ 'g.txt': 'x\n' })
    try {
      const diff = createStagepick({ cwd: clean.dir }).list()
      expect(decode(encode({ files: [] }))).toEqual({ files: [] })
      expect(decode(formatToon(diff))).toEqual({ files: [] })
    }
    finally {
      clean.cleanup()
    }
  })
})
