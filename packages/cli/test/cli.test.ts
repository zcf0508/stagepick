import type { TestRepo } from '../../core/test/helpers/repo.js'
import { Buffer } from 'node:buffer'
import { decode } from '@toon-format/toon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRepo } from '../../core/test/helpers/repo.js'
import { runCli } from '../src/cli.js'

let repo: TestRepo

beforeEach(() => {
  repo = createRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
})

afterEach(() => {
  repo.cleanup()
})

async function runList(args: string[]): Promise<{ files: Array<{ path: string, status: string }> }> {
  let output = ''
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stdout.write
  try {
    await runCli(['list', ...args])
  }
  finally {
    process.stdout.write = originalWrite
  }
  return decode(output) as { files: Array<{ path: string, status: string }> }
}

describe('list pathspec parsing', () => {
  it('does not treat bare arguments before the separator as pathspecs', async () => {
    repo.write('a.txt', 'A\n')
    repo.write('b.txt', 'B\n')

    const result = await runList(['--toon', '--cwd', repo.dir, 'a.txt'])
    expect(result.files.map(file => file.path)).toEqual(['a.txt', 'b.txt'])
  })

  it('filters tracked and untracked paths after the separator', async () => {
    repo.write('a.txt', 'A\n')
    repo.write('b.txt', 'B\n')
    repo.write('new.txt', 'new\n')

    const result = await runList(['--toon', '--cwd', repo.dir, '--', 'a.txt', 'new.txt'])
    expect(result.files.map(file => file.path)).toEqual(['a.txt', 'new.txt'])
  })

  it('keeps options before the separator and treats everything after it as a pathspec', async () => {
    repo.write('--staged', 'before\n')
    repo.git('add', '--', '--staged')
    repo.git('commit', '-qm', 'add staged-named file')
    repo.write('--staged', 'after\n')

    const result = await runList(['--toon', '--cwd', repo.dir, '--', '--staged'])
    expect(result.files.map(file => file.path)).toEqual(['--staged'])
  })

  it('filters staged changes and protects pathnames beginning with a dash', async () => {
    repo.write('-file.txt', 'before\n')
    repo.git('add', '--', '-file.txt')
    repo.git('commit', '-qm', 'add dash file')
    repo.write('-file.txt', 'after\n')
    repo.write('a.txt', 'A\n')
    repo.git('add', 'a.txt')

    const result = await runList(['--staged', '--toon', '--cwd', repo.dir, '--', 'a.txt'])
    expect(result.files.map(file => file.path)).toEqual(['a.txt'])

    const dashFile = await runList(['--toon', '--cwd', repo.dir, '--', '-file.txt'])
    expect(dashFile.files.map(file => file.path)).toEqual(['-file.txt'])
  })

  it('treats help-looking pathnames after the separator as pathspecs', async () => {
    repo.write('--help', 'before\n')
    repo.write('-h', 'before\n')
    repo.git('add', '--', '--help', '-h')
    repo.git('commit', '-qm', 'add help-named files')
    repo.write('--help', 'after\n')
    repo.write('-h', 'after\n')

    const result = await runList(['--toon', '--cwd', repo.dir, '--', '--help', '-h'])
    expect(result.files.map(file => file.path)).toEqual(['--help', '-h'])
  })
})
