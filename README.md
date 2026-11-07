# mcp-plugin-kit

Ship one remote MCP server to both the ChatGPT and Claude plugin directories from a single spec file.

Version 0.1 supports one public, unauthenticated, read-only HTTPS MCP server. It does not configure OAuth, authenticated servers, local servers or write tools. The generated disclosure assumes this scope; you must verify your server actually meets it.

You describe the plugin once in `plugin-src/spec.json`: names, descriptions, endpoint, policies, starter prompts and review test cases. The kit writes both packages, keeps them consistent with each other, and fails your build when either one drifts from the spec.

- `plugin/`: the ChatGPT package (`plugin.json` with the `com.openai` extension, `mcp.json`, icon)
- `claude-plugin/`: the Claude package (`.claude-plugin/plugin.json`, `marketplace.json`, `.mcp.json`, a generated skill, README, LICENSE, icon)
- `output/*.zip`: one upload archive per directory, byte-reproducible

This is a reference implementation extracted from the packaging workflows for [The Stoic Library](https://thestoiclibrary.com/plugin) and [The Founding Reader](https://foundingreader.com). The public example is the spec of The Stoic Library 1.0.1 as shipped. From it the kit rebuilds the ChatGPT package OpenAI accepted byte for byte (`test/fixtures/` holds that package and `test/reproduce.test.mjs` checks it), and the Claude package published at that version except for one README sentence that was made generic. Both directories change their requirements; inspect the generated files and current submission rules before submitting.

## Guide

[`docs/GUIDE.md`](docs/GUIDE.md) covers what the generator cannot: server design that passes review, endpoint hardening, testing layers, review cases, both submission processes, the walkthrough video and the pitfalls we hit.

## Requirements

Node 20 or later. No runtime dependencies. The tests also need Python 3 (independent ZIP verification), Bash and Git (publishing script test). The optional publishing script requires Bash, Git and an authenticated GitHub CLI.

## Use

Clone the kit and copy the example into a new working folder:

```sh
git clone https://github.com/DlaregY/mcp-plugin-kit.git
mkdir my-plugin
cp -R mcp-plugin-kit/examples/stoic-library/plugin-src my-plugin/
cd my-plugin
```

Edit `plugin-src/spec.json`, replace the icon and instructions, and replace every example name, URL, contact, disclosure, prompt and review case with your own. Set `copyrightYear` explicitly. Keep exactly five positive and three negative review cases, covering all your tools. Then run locally:

```sh
node ../mcp-plugin-kit/bin/mcp-plugin-kit.mjs validate
node ../mcp-plugin-kit/bin/mcp-plugin-kit.mjs build --zip
node ../mcp-plugin-kit/bin/mcp-plugin-kit.mjs check
```

Alternatively, from an existing project with `plugin-src/`:

```
npx github:DlaregY/mcp-plugin-kit validate
npx github:DlaregY/mcp-plugin-kit build --zip
npx github:DlaregY/mcp-plugin-kit check    # in CI: exit 1 if committed packages are stale
```

Run from the directory that contains `plugin-src/`, or pass `--spec path/to/spec.json`. Output lands beside `plugin-src/` unless you pass `--out`.

Output subdirectories can be set with `output.openai` and `output.claude`. They must be distinct, non-overlapping relative paths without dot segments. With `--zip` neither may contain the ZIPs, so `output` itself is refused; a package below `output/` is allowed unless it collides with a ZIP name. Build preflights inputs and destinations, including ZIP destinations, before it writes anything, never deletes directories, and refuses unexpected output files; move those files out deliberately before rebuilding. Files that file managers drop into folders (`.DS_Store`, `Thumbs.db`, `desktop.ini`) are ignored, never zipped and never published. `check` detects missing, changed and unexpected files. Builds are not transactions: an operating-system failure during writing may leave partial output; rerun build and check after correcting the failure. Do not run concurrent writers against the same output directories.

For programmatic use, install from GitHub (the package is not published on npm):

```sh
npm install github:DlaregY/mcp-plugin-kit
```

Then pass the exact instructions string your server serves so the Claude skill can never disagree with it:

```js
import { buildTargets, drift, loadSpec } from "mcp-plugin-kit";
import { instructions } from "./server.mjs";

const { spec, baseDir } = loadSpec("plugin-src/spec.json");
const targets = buildTargets(spec, { baseDir, outDir: ".", instructions });
if (drift(targets).length) process.exit(1);
```

`zip()` refuses a destination that overlaps a package. If you call both `write()` and `zip()`, call `checkArchives(targets, spec, zipDir)` first, as the CLI does, so that refusal comes before any package file changes. `write()`, `drift()` and `zip()` trust the targets they are given: the input rules below apply to what `buildTargets` returns, not to file maps you edit or construct yourself.

## The spec

Start from [`examples/stoic-library/plugin-src/spec.json`](examples/stoic-library/plugin-src/spec.json). Fields that need care:

| Field | Used for |
| --- | --- |
| `toolsSummary` | One sentence naming each tool, completing "The connector provides ...". Goes in the skill and README. |
| `readmeToolsSummary` | Optional plainer version for the README. |
| `author` | `name`, `email` and optional HTTPS `url`, published in both manifests. Other keys fail validation so private notes cannot reach a package. |
| `dataNotice` | What each tool call sends and what the endpoint keeps. Reviewers read this. |
| `notFoundNotice` | Closing README line on how to read empty results. |
| `instructions` / `instructionsFile` | The model-facing rules, copied into the Claude skill. |
| `reviewCases.positive` / `.negative` | ChatGPT review test cases; also rendered into the skill as expected behavior. Positive cases take `description`, `prompt`, `tools_triggered` and `expected_behavior`; negative cases take the same fields without `tools_triggered`. Other keys and other groups fail validation. |
| `claude.marketplace` | Marketplace name. It must be unique across every marketplace a user adds, so do not reuse one name for two repos. |
| `claude.directoryUrl` | Optional HTTPS URL of the published Claude directory listing. The generated README links there instead of giving ZIP upload instructions. Omit it for unlisted plugins. |
| `icon` | PNG file, copied into both packages as `assets/icon.png`. |
| `license` | `MIT` is generated. Anything else needs `licenseFile`. |

`icon`, `instructionsFile` and `licenseFile` are relative paths to regular files inside the directory that holds the spec, usually `plugin-src/`. Their contents are published, so absolute paths are refused, and so is any path that leaves that directory, whether by `..` or through a symlink. A symlink that stays inside the directory is fine. To use a shared file, copy it next to the spec.

`validate` checks required field types, HTTPS URLs, listing lengths, starter prompt and capability limits, the required demo URL, review-case counts and local input files, including that the icon has a PNG header. It does not decode the image, certify directory acceptance, test server behavior or contact URLs. Library callers should pass `{ baseDir }` to `validate` to check local files; `buildTargets` always does.

### Upgrading from 0.2.0

These changes can make a spec that used to pass fail. Generated output for specs that still pass is unchanged.

- `icon`, `instructionsFile` and `licenseFile` must be relative paths that stay inside the spec's directory after symlinks resolve.
- `icon` must have a PNG header.
- `author` accepts only `name`, `email` and `url`, and `author.url` must be HTTPS.
- `reviewCases` accepts only the `positive` and `negative` groups and the fields listed above.
- `build --zip` refuses an `output.openai` or `output.claude` that holds the ZIPs, where 0.2.0 wrote the ZIPs into the package and failed on the next build.

## Publishing the Claude package

The Claude directory installs from a public GitHub repo whose root is the `claude-plugin/` folder. Mirror it on each release and tag the spec version; see [`scripts/publish-claude-repo.sh`](scripts/publish-claude-repo.sh).

The script replaces the destination repository's contents, so use a dedicated package repo. It honors `output.claude` and accepts an optional second argument matching the CLI's `--out`. It refuses an existing version tag with different contents and pushes a new commit and tag atomically. Review the generated package and destination before running it.

Set `git config user.name` and `git config user.email` in the source project before publishing, or supply `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`. The publisher uses that identity for both author and committer and stops if either value is missing.

## License

MIT
