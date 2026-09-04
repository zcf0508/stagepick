# Contributing

## Setup

```bash
pnpm install
```

## Development loop

```bash
pnpm lint:fix     # ESLint (@antfu/eslint-config) with autofix
pnpm typecheck    # tsc --noEmit, strict
pnpm test         # vitest: unit tests + real-git e2e (needs git on PATH)
pnpm build        # tsdown for packages/core and packages/cli
```

Please run all four before opening a PR. CI enforces them on
ubuntu / windows / macos.

## Architecture

Two packages:

- `packages/core` (`@stagepick/core`) — everything: diff parsing, selectors,
  selection planning, patch emission, the git runner, and the `createStagepick`
  facade. No CLI dependencies.
- `packages/cli` (`stagepick`) — a thin citty wrapper over core.

Within core, the split is deliberate:

- **Pure functions** (`parse`, `selector`, `select`, `patch`, `format`) hold all
  decisions and are unit-tested cheaply. They never spawn processes.
- **Side effects** (`git.ts`) are the single thin boundary that talks to git,
  always shell-free via execa.

## Testing guidelines

- Unit-test decisions (parsing, selection, patch emission) as pure functions.
- E2e-test the git boundary in real temporary repositories
  (`packages/core/test/e2e.test.ts`): staging must be verified through
  `git diff --cached`, not through our own data structures.
- When fixing a bug, add the failing test first. Prefer `toMatchInlineSnapshot`
  or explicit structural assertions over fuzzy `toContain` chains.
- Hand-written diff fixtures must keep their `@@` header counts consistent with
  the body — the parser consumes bodies by count. When in doubt, generate the
  fixture with real git in an e2e test instead.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), e.g.
`fix(core): recompute anchors for zero-count sides`. No `Co-Authored-By`
trailers, please.

## Code style

- TypeScript strict; **no `any`** — use `unknown` and narrow.
- Prefer discriminated unions so related data narrows naturally.
- antfu ESLint rules; the formatter is not negotiable, run `pnpm lint:fix`.
