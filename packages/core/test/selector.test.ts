import { describe, expect, it } from 'vitest'
import { parseSelector, SelectorParseError } from '../src/selector.js'

describe('parseSelector', () => {
  it('parses a bare path as a whole-file selector', () => {
    expect(parseSelector('src/app.ts')).toEqual({ kind: 'file', path: 'src/app.ts' })
  })

  it('parses a hex id as a hunk selector', () => {
    expect(parseSelector('a1b2c3d4')).toEqual({ kind: 'hunk', id: 'a1b2c3d4', path: null })
    expect(parseSelector('A1B2C3D4')).toEqual({ kind: 'hunk', id: 'a1b2c3d4', path: null })
    expect(parseSelector('a1b2')).toEqual({ kind: 'hunk', id: 'a1b2', path: null })
  })

  it('parses path#id as a file-restricted hunk selector', () => {
    expect(parseSelector('src/app.ts#a1b2c3d4')).toEqual({ kind: 'hunk', id: 'a1b2c3d4', path: 'src/app.ts' })
  })

  it('parses path:lines as a line-range selector', () => {
    expect(parseSelector('src/app.ts:42')).toEqual({ kind: 'lines', path: 'src/app.ts', ranges: [[42, 42]] })
    expect(parseSelector('src/app.ts:42-45')).toEqual({ kind: 'lines', path: 'src/app.ts', ranges: [[42, 45]] })
    expect(parseSelector('src/app.ts:10-20,30,40-45')).toEqual({
      kind: 'lines',
      path: 'src/app.ts',
      ranges: [[10, 20], [30, 30], [40, 45]],
    })
  })

  it('parses id@Lset as a changed-lines selector', () => {
    expect(parseSelector('a1b2c3d4@L1,3-5')).toEqual({ kind: 'hunkLines', id: 'a1b2c3d4', path: null, lines: [1, 3, 4, 5] })
    expect(parseSelector('a1b2c3d4@L2')).toEqual({ kind: 'hunkLines', id: 'a1b2c3d4', path: null, lines: [2] })
    expect(parseSelector('src/app.ts#a1b2c3d4@L2-3')).toEqual({ kind: 'hunkLines', id: 'a1b2c3d4', path: 'src/app.ts', lines: [2, 3] })
  })

  it('parses purely numeric tokens as hunk ids (ids can be all digits)', () => {
    expect(parseSelector('12345')).toEqual({ kind: 'hunk', id: '12345', path: null })
    expect(parseSelector('10879878')).toEqual({ kind: 'hunk', id: '10879878', path: null })
  })

  it('strips the ./ escape prefix for file paths', () => {
    expect(parseSelector('./deadbeef')).toEqual({ kind: 'file', path: 'deadbeef' })
  })

  it('normalizes number sets (sorted, deduplicated)', () => {
    expect(parseSelector('a1b2c3d4@L3-5,1,3')).toEqual({ kind: 'hunkLines', id: 'a1b2c3d4', path: null, lines: [1, 3, 4, 5] })
  })

  it('rejects invalid selectors with a parse error', () => {
    expect(() => parseSelector('')).toThrow(SelectorParseError)
    expect(() => parseSelector('a1b2@X1')).toThrow(SelectorParseError)
    expect(() => parseSelector('a1b2@L0')).toThrow(SelectorParseError)
    expect(() => parseSelector('a1b2@L3-2')).toThrow(SelectorParseError)
    expect(() => parseSelector('f.ts:0')).toThrow(SelectorParseError)
    expect(() => parseSelector('f.ts:5-2')).toThrow(SelectorParseError)
    expect(() => parseSelector('#a1b2')).toThrow(SelectorParseError)
    expect(() => parseSelector('f.ts#xyz1')).toThrow(SelectorParseError)
  })
})
