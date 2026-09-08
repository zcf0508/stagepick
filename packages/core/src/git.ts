import { execaSync, ExecaSyncError } from 'execa'
import { StagepickError } from './errors.js'

/**
 * The only module that talks to git. All commands run via execa with no shell,
 * so arguments and patch bytes cross process boundaries as raw pipes — immune to the
 * encoding/line-ending damage shell pipelines inflict (Windows PowerShell 5.1 in particular).
 */

export interface GitRunner {
  /** `git diff` (worktree vs index) or `git diff --cached` (index vs HEAD), decoded as UTF-8. */
  diff: (staged: boolean, paths?: readonly string[]) => string
  /** Apply a patch to the index (`git apply --cached`), feeding the patch on stdin. */
  applyToIndex: (patch: string, reverse: boolean) => void
  /** `git add -- <paths>` (stage whole files, e.g. untracked). */
  add: (paths: string[]) => void
  /** `git add -N -- <paths>` (intent-to-add so new files appear in `git diff`). */
  addIntentToAdd: (paths: string[]) => void
  /** Untracked, non-ignored paths, repo-relative POSIX style. */
  untracked: (paths?: readonly string[]) => string[]
}

export class GitError extends StagepickError {
  override readonly name = 'GitError'
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message, 'git-failed', false)
  }
}

const MAX_BUFFER = 512 * 1024 * 1024

function run(cwd: string, args: string[], input?: string): string {
  try {
    const { stdout } = execaSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      // Preserve the output byte-exactly: execa's default strips a trailing \r\n,
      // which would eat the \r of a CRLF file's last line from `git diff`.
      stripFinalNewline: false,
      ...(input === undefined ? {} : { input }),
    })
    return stdout
  }
  catch (error) {
    if (error instanceof ExecaSyncError) {
      const stderr = typeof error.stderr === 'string' ? error.stderr : ''
      throw new GitError(
        `git ${args.join(' ')} failed (exit ${error.exitCode ?? '?'}): ${stderr.trim() || error.shortMessage}`,
        stderr,
        error.exitCode ?? null,
      )
    }
    throw error
  }
}

export function createGitRunner(cwd: string): GitRunner {
  return {
    diff(staged, paths = []) {
      const args = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv']
      if (staged)
        args.push('--cached')
      if (paths.length > 0)
        args.push('--', ...paths)
      return run(cwd, args)
    },
    applyToIndex(patch, reverse) {
      const args = ['apply', '--cached', '--whitespace=nowarn']
      if (reverse)
        args.push('-R')
      args.push('-')
      run(cwd, args, patch.endsWith('\n') ? patch : `${patch}\n`)
    },
    add(paths) {
      if (paths.length > 0)
        run(cwd, ['add', '--', ...paths])
    },
    addIntentToAdd(paths) {
      if (paths.length > 0)
        run(cwd, ['add', '-N', '--', ...paths])
    },
    untracked(paths = []) {
      const args = ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']
      if (paths.length > 0)
        args.push('--', ...paths)
      const out = run(cwd, args)
      return out.split('\n').filter(line => line.length > 0)
    },
  }
}
