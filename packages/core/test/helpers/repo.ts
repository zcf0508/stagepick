import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TestRepo {
  dir: string
  git: (...args: string[]) => string
  write: (path: string, content: string) => void
  remove: (path: string) => void
  /** worktree vs index */
  diff: () => string
  /** index vs HEAD */
  diffStaged: () => string
  cleanup: () => void
}

export function createRepo(files: Record<string, string> = {}): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'stagepick-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })

  git('init', '-q')
  git('config', 'user.email', 'test@stagepick.dev')
  git('config', 'user.name', 'stagepick-test')
  git('config', 'core.autocrlf', 'false')

  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }

  for (const [path, content] of Object.entries(files))
    write(path, content)

  if (Object.keys(files).length > 0) {
    git('add', '-A')
    git('commit', '-qm', 'init')
  }
  else {
    git('commit', '-q', '--allow-empty', '-m', 'init')
  }

  return {
    dir,
    git,
    write,
    remove: (path: string) => rmSync(join(dir, path), { force: true }),
    diff: () => git('-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff'),
    diffStaged: () => git('-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--cached'),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }),
  }
}

/** The hunkpick new-side-anchor fixture: 30 lines, an insertion near the top, a replacement further down. */
export function anchorFixture(): { before: string, after: string } {
  const before = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\n`
  const after = `${Array.from({ length: 30 }, (_, i) => {
    if (i === 2)
      return 'line 3\ninserted A'
    if (i === 19)
      return 'LINE 20'
    return `line ${i + 1}`
  }).join('\n')}\n`
  return { before, after }
}
