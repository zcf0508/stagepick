#!/usr/bin/env node
import type { StageResult } from '@stagepick/core'
import process from 'node:process'
import { createStagepick, formatHuman, formatJson, SelectionError, SelectorParseError } from '@stagepick/core'
import { defineCommand, runMain } from 'citty'

const VERSION = '0.1.0'

class UsageError extends Error {
  override readonly name = 'UsageError'
}

function exitCodeOf(error: unknown): number {
  if (error instanceof UsageError || error instanceof SelectorParseError || error instanceof SelectionError)
    return 2
  return 1
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run a command body, mapping known error types onto exit codes (2 = usage, 1 = git/internal). */
function guard(fn: () => void): void {
  try {
    fn()
  }
  catch (error) {
    process.stderr.write(`stagepick: ${messageOf(error)}\n`)
    process.exitCode = exitCodeOf(error)
  }
}

function printDryRun(result: StageResult): void {
  if (result.patch)
    process.stdout.write(result.patch)
  for (const path of result.addedUntracked)
    process.stdout.write(`# would git add -- ${path}\n`)
}

function printSummary(verb: 'staged' | 'unstaged', result: StageResult): void {
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
    json: { type: 'boolean', description: 'Machine-readable output', default: false },
    lines: { type: 'boolean', description: 'Show changed lines with their L-numbers (for @L selectors)', default: false },
    staged: { type: 'boolean', description: 'List index-vs-HEAD instead of worktree-vs-index', default: false },
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
    })
  },
})

const stage = defineCommand({
  meta: {
    name: 'stage',
    description: 'Stage selected hunks/lines into the index. Selectors: path | <id> | path#<id> | path:42-45,50 | <id>@L1,3-5 | path#<id>@L2',
  },
  args: {
    ...sharedArgs,
    dryRun: { type: 'boolean', description: 'Print the patch instead of applying it', default: false },
  },
  run({ args }) {
    guard(() => {
      const selectors = args._.map(String)
      if (selectors.length === 0)
        throw new UsageError('stage requires at least one selector (run `stagepick list --lines` to pick ids and lines)')
      const stagepick = createStagepick({ cwd: args.cwd })
      const result = stagepick.stage(selectors, { dryRun: args.dryRun })
      if (args.dryRun) {
        printDryRun(result)
        return
      }
      printSummary('staged', result)
    })
  },
})

const unstage = defineCommand({
  meta: {
    name: 'unstage',
    description: 'Remove selected hunks/lines from the index (reverse of stage; same selector grammar)',
  },
  args: {
    ...sharedArgs,
    dryRun: { type: 'boolean', description: 'Print the reverse patch instead of applying it', default: false },
  },
  run({ args }) {
    guard(() => {
      const selectors = args._.map(String)
      if (selectors.length === 0)
        throw new UsageError('unstage requires at least one selector (run `stagepick list --staged` to pick ids and lines)')
      const stagepick = createStagepick({ cwd: args.cwd })
      const result = stagepick.unstage(selectors, { dryRun: args.dryRun })
      if (args.dryRun) {
        printDryRun(result)
        return
      }
      printSummary('unstaged', result)
    })
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
