# @stagepick/core

Core library for [stagepick](https://github.com/zcf0508/stagepick): parse git diffs,
select hunks and individual lines, and build partial-staging patches — the engine behind
the `stagepick` CLI, made for embedding into agent runtimes.

```ts
import { createStagepick } from '@stagepick/core'

const sp = createStagepick({ cwd: process.cwd() })
const diff = sp.list({ paths: ['src/app.ts'] })
const id = diff.files[0]!.hunks[0]!.id
sp.stage([id]) // or ['src/app.ts:42-45'], ['a1b2c3d4@L2'], ...
```

Full documentation, selector grammar, and the agent skill live in the
[GitHub repository](https://github.com/zcf0508/stagepick).

## License

MIT
