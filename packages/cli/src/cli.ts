#!/usr/bin/env node
import type { StageResult } from '@stagepick/core'
import process from 'node:process'
import { createStagepick, exitCodeOf, formatHuman, formatJson, StagepickError, toJsonError } from '@stagepick/core'
import { defineCommand, runMain } from 'citty'

const VERSION = '0.1.0'

class UsageError extends StagepickError {
  override readonly name = 'UsageError'

  constructor(message: string) {
    super(message, 'usage', false)
  }
}

/** Run a command body, mapping typed errors onto JSON/plain output and documented exit codes. */
function guard(fn: () => void, json: boolean): void {
  try {
    fn()
  }
  catch (error) {
    if (json) {
      process.stderr.write(`${JSON.stringify(toJsonError(error))}\n`)
    }
    else {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`stagepick: ${message}\n`)
    }
    process.exitCode = exitCodeOf(error)
  }
}

function printDryRun(result: StageResult): void {
  if (result.patch)
    process.stdout.write(result.patch)
  for (const path of result.addedUntracked)
    process.stdout.write(`# would git add -- ${path}\n`)
}

function printResult(verb: 'staged' | 'unstaged', result: StageResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: verb,
      hunks: result.hunks,
      files: result.files,
      addedUntracked: result.addedUntracked,
      dryRun: result.dryRun,
      ...(result.dryRun ? { patch: result.patch } : {}),
    })}\n`)
    return
  }
  if (result.dryRun) {
    printDryRun(result)
    return
  }
  const parts = [`${verb} ${result.hunks} hunk(s) in ${result.files} file(s)`]
  if (result.addedUntracked.length > 0)
    parts.push(`${verb} ${result.addedUntracked.length} untracked file(s) whole: ${result.addedUntracked.join(', ')}`)
  process.stdout.write(`${parts.join('; ')}\n`)
}

const sharedArgs = {
  cwd: {
    type: 'string',
    description: 'Repository directory',
    default: process.cwd(),
  },
} as const

const list = defineCommand({
  meta: {
    name: 'list',
    description: 'List changes with stable hunk ids (unstaged by default, --staged for index vs HEAD)',
  },
  args: {
    ...sharedArgs,
    // Boolean flags intentionally omit `default: false`: citty 0.1.6's proxy resolves
    // the defined key before kebab-case fallbacks, so a default would mask `--dry-run`.
    json: { type: 'boolean', description: 'Machine-readable JSON output' },
    lines: { type: 'boolean', description: 'Show changed lines with their L-numbers (for @L selectors)' },
    staged: { type: 'boolean', description: 'List index-vs-HEAD instead of worktree-vs-index' },
  },
  run({ args }) {
    guard(() => {
      const stagepick = createStagepick({ cwd: args.cwd })
      const diff = stagepick.list({ staged: args.staged })
      if (diff.files.length === 0) {
        process.stdout.write(args.json ? '{"files":[]}\n' : 'no changes\n')
        return
      }
      process.stdout.write(args.json ? `${formatJson(diff)}\n` : `${formatHuman(diff, { lines: args.lines })}\n`)
    }, args.json)
  },
})

const mutateArgs = {
  ...sharedArgs,
  dryRun: { type: 'boolean', description: 'Print the patch instead of applying it' },
  json: { type: 'boolean', description: 'Machine-readable JSON result and error output' },
} as const

const stage = defineCommand({
  meta: {
    name: 'stage',
    description: 'Stage selected hunks/lines into the index. Selectors: path | <id> | path#<id> | path:42-45,50 | <id>@L1,3-5 | path#<id>@L2',
  },
  args: mutateArgs,
  run({ args }) {
    guard(() => {
      const selectors = args._.map(String)
      if (selectors.length === 0)
        throw new UsageError('stage requires at least one selector (run `stagepick list --lines` to pick ids and lines)')
      const stagepick = createStagepick({ cwd: args.cwd })
      const result = stagepick.stage(selectors, { dryRun: args.dryRun })
      printResult('staged', result, args.json)
    }, args.json)
  },
})

const unstage = defineCommand({
  meta: {
    name: 'unstage',
    description: 'Remove selected hunks/lines from the index (reverse of stage; same selector grammar)',
  },
  args: mutateArgs,
  run({ args }) {
    guard(() => {
      const selectors = args._.map(String)
      if (selectors.length === 0)
        throw new UsageError('unstage requires at least one selector (run `stagepick list --staged` to pick ids and lines)')
      const stagepick = createStagepick({ cwd: args.cwd })
      const result = stagepick.unstage(selectors, { dryRun: args.dryRun })
      printResult('unstaged', result, args.json)
    }, args.json)
  },
})

const main = defineCommand({
  meta: {
    name: 'stagepick',
    version: VERSION,
    description: 'Non-interactive git staging for agents and scripts: stage hunks or individual lines by stable content ids and file line numbers',
  },
  subCommands: { list, stage, unstage },
})

runMain(main)
