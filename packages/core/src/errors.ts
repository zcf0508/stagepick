/**
 * Typed errors: the machine-branchable counterpart of the human-readable message.
 *
 * The contract mirrors agent-ready error design: `code` and `retryable` carry the
 * machine logic (never parse `message` for control flow — it may be reworded),
 * while `exitCodeOf` maps them onto the CLI's documented exit codes.
 */

export type StagepickErrorCode
  /** CLI grammar broken (bad selector syntax, unknown flag, missing arguments). */
  = | 'usage'
  /** Selector parsed but its hunk id matches nothing — the diff likely drifted. */
    | 'unknown-hunk'
  /** Selector's path has no changes in the current diff. */
    | 'unknown-path'
  /** Line ranges touch no change run. */
    | 'lines-not-matched'
  /** @L number outside the hunk's changed-line range. */
    | 'changed-line-out-of-range'
  /** Nothing matched the selection at all. */
    | 'nothing-to-stage'
  /** A git command failed (patch rejected, not a repo, ...). */
    | 'git-failed'
  /** A multi-step write partially completed; inspect `completed` before retrying. */
    | 'partial-failure'

export class StagepickError extends Error {
  override readonly name: string = 'StagepickError'

  constructor(
    message: string,
    /** Machine-branchable code; stable across message rewording. */
    readonly code: StagepickErrorCode,
    /** True when re-running `list` and rebuilding selectors is a viable retry. */
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

export interface PartialFailureDetails {
  /** Whether the patch had already been applied to the index when the failure hit. */
  patchApplied: boolean
  /** Untracked paths whose `git add` succeeded before the failure. */
  addedUntracked: string[]
  /** Untracked paths that still need staging. */
  remainingUntracked: string[]
}

export class PartialFailureError extends StagepickError {
  override readonly name = 'PartialFailureError'

  constructor(
    message: string,
    /** What already happened — the recovery contract for callers. */
    readonly completed: PartialFailureDetails,
    readonly cause: unknown,
  ) {
    super(message, 'partial-failure', false)
  }
}

/**
 * CLI exit code contract:
 *   0  success
 *   1  git or internal failure
 *   2  usage error (bad grammar)
 *   3  invalid/stale selection — recover by re-running `list`
 *   4  partial failure — some writes already landed; inspect before retrying
 */
export function exitCodeOf(error: unknown): 1 | 2 | 3 | 4 {
  if (error instanceof PartialFailureError)
    return 4
  if (error instanceof StagepickError) {
    switch (error.code) {
      case 'usage':
        return 2
      case 'unknown-hunk':
      case 'unknown-path':
      case 'lines-not-matched':
      case 'changed-line-out-of-range':
      case 'nothing-to-stage':
        return 3
      case 'git-failed':
      case 'partial-failure':
        return 1
    }
  }
  return 1
}

/** Serializable error shape for `--json` output on failures. */
export interface JsonError {
  error: {
    code: StagepickErrorCode | 'internal'
    message: string
    retryable: boolean
  }
}

export function toJsonError(error: unknown): JsonError {
  if (error instanceof StagepickError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
    }
  }
  return {
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  }
}
