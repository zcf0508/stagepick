#!/usr/bin/env node
import type { StageResult } from '@stagepick/core'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createStagepick, exitCodeOf, formatHuman, formatJson, formatToon, StagepickError, toJsonError } from '@stagepick/core'
import { encode } from '@toon-format/toon'
import { defineCommand, runCommand, runMain } from 'citty'
import pkg from '../package.json' with { type: 'json' }

const VERSION = pkg.version

class UsageError extends StagepickError {
  override readonly name = 'UsageError'

  constructor(message: string) {
    super(message, 'usage', false)
  }
}

type OutputFormat = 'human' | 'json' | 'toon'

function formatOf(args: { json: boolean, toon: boolean }): OutputFormat {
  if (args.toon)
    return 'toon'
  if (args.json)
    return 'json'
  return 'human'
}

/** Run a command body, mapping typed errors onto machine/plain output and documented exit codes. */
function guard(fn: () => void, machine: boolean): void {
  try {
    fn()
  }
  catch (error) {
    if (machine) {
      // Errors stay JSON in both machine modes so control flow never depends on the data format.
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

function printResult(verb: 'staged' | 'unstaged', result: StageResult, format: OutputFormat): void {
  if (format !== 'human') {
    const payload = {
      ok: true,
      action: verb,
      hunks: result.hunks,
      files: result.files,
      addedUntracked: result.addedUntracked,
      dryRun: result.dryRun,
      ...(result.dryRun ? { patch: result.patch } : {}),
    }
    process.stdout.write(format === 'toon' ? `${encode(payload)}\n` : `${JSON.stringify(payload)}\n`)
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
    description: 'List changes with stable hunk ids (unstaged by default, --staged for index vs HEAD; append pathspecs after -- to limit paths)',
  },
  args: {
    ...sharedArgs,
    // Boolean flags intentionally omit `default: false`: citty 0.1.6's proxy resolves
    // the defined key before kebab-case fallbacks, so a default would mask `--dry-run`.
    json: { type: 'boolean', description: 'Machine-readable JSON output' },
    toon: { type: 'boolean', description: 'Machine-readable TOON output (fewer LLM tokens; same model as --json)' },
    lines: { type: 'boolean', description: 'Show changed lines with their L-numbers (for @L selectors)' },
    staged: { type: 'boolean', description: 'List index-vs-HEAD instead of worktree-vs-index' },
  },
  run({ args, rawArgs }) {
    const format = formatOf(args)
    guard(() => {
      const stagepick = createStagepick({ cwd: args.cwd })
      const separator = rawArgs.indexOf('--')
      const paths = separator === -1 ? [] : rawArgs.slice(separator + 1)
      const diff = stagepick.list({ staged: args.staged, paths })
      if (diff.files.length === 0) {
        process.stdout.write(format === 'toon' ? `${encode({ files: [] })}\n` : format === 'json' ? '{"files":[]}\n' : 'no changes\n')
        return
      }
      process.stdout.write(format === 'toon' ? `${formatToon(diff)}\n` : format === 'json' ? `${formatJson(diff)}\n` : `${formatHuman(diff, { lines: args.lines })}\n`)
    }, format !== 'human')
  },
})

const mutateArgs = {
  ...sharedArgs,
  dryRun: { type: 'boolean', description: 'Print the patch instead of applying it' },
  json: { type: 'boolean', description: 'Machine-readable JSON result and error output' },
  toon: { type: 'boolean', description: 'Machine-readable TOON result output (errors stay JSON)' },
} as const

const stage = defineCommand({
  meta: {
    name: 'stage',
    description: 'Stage selected hunks/lines into the index. Selectors: path | <id> | path#<id> | path:42-45,50 | <id>@L1,3-5 | path#<id>@L2',
  },
  args: mutateArgs,
  run({ args }) {
    const format = formatOf(args)
    guard(() => {
      const selectors = args._.map(String)
      if (selectors.length === 0)
        throw new UsageError('stage requires at least one selector (run `stagepick list --toon` to pick ids and lines)')
      const stagepick = createStagepick({ cwd: args.cwd })
      const result = stagepick.stage(selectors, { dryRun: args.dryRun })
      printResult('staged', result, format)
    }, format !== 'human')
  },
})

const unstage = defineCommand({
  meta: {
    name: 'unstage',
    description: 'Remove selected hunks/lines from the index (reverse of stage; same selector grammar)',
  },
  args: mutateArgs,
  run({ args }) {
    const format = formatOf(args)
    guard(() => {
      const selectors = args._.map(String)
      if (selectors.length === 0)
        throw new UsageError('unstage requires at least one selector (run `stagepick list --toon --staged` to pick ids and lines)')
      const stagepick = createStagepick({ cwd: args.cwd })
      const result = stagepick.unstage(selectors, { dryRun: args.dryRun })
      printResult('unstaged', result, format)
    }, format !== 'human')
  },
})

export const main = defineCommand({
  meta: {
    name: 'stagepick',
    version: VERSION,
    description: 'Non-interactive git staging for agents and scripts: stage hunks or individual lines by stable content ids and file line numbers',
  },
  subCommands: { list, stage, unstage },
})

export async function runCli(rawArgs: readonly string[]): Promise<void> {
  const separator = rawArgs.indexOf('--')
  const pathspecs = separator === -1 ? [] : rawArgs.slice(separator + 1)
  // Citty's runMain scans all raw arguments for help before honoring `--`.
  // Bypass only that scan when a pathspec would be mistaken for a help flag.
  if (pathspecs.includes('--help') || pathspecs.includes('-h')) {
    await runCommand(main, { rawArgs: [...rawArgs] })
    return
  }
  await runMain(main, { rawArgs: [...rawArgs] })
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  if (entrypoint === undefined)
    return false
  try {
    // npm's bin links invoke the CLI through a symlink, so compare resolved paths.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint)
  }
  catch {
    return false
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`stagepick: ${message}\n`)
    process.exitCode = 1
  })
}
