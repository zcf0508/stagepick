# stagepick

Non-interactive git staging for AI agents and scripts. Stage hunks or individual lines
by stable content ids and file line numbers — no TTY, no hand-written patches.

```bash
stagepick list --toon                  # inspect changes: files, hunks, stable ids, line numbers
stagepick list --toon -- src/app.ts    # inspect only selected paths (Git pathspecs)
stagepick stage a1b2c3d4               # stage one hunk by content id
stagepick stage src/app.ts:42-45       # stage the change runs touching those lines
stagepick stage a1b2c3d4@L2            # stage one changed line inside a hunk
git diff --cached                      # verify, then commit as usual
```

`list --toon` emits the machine-readable model as [TOON](https://github.com/toon-format/toon)
(fewer tokens for LLMs); `--json` emits the identical model as JSON. Append Git
pathspecs after `--` to list only selected files or directories.

## Install

```bash
npm install -g stagepick
```

Requires Node.js ≥ 20 and `git` on `PATH`.

Full documentation, the `@stagepick/core` library API, and the agent skill live in the
[GitHub repository](https://github.com/zcf0508/stagepick).

## License

MIT
