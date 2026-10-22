# Shipping one MCP server to ChatGPT and Claude

A field guide to packaging a remote MCP server for the ChatGPT and Claude directories, drawn from work on [The Stoic Library](https://thestoiclibrary.com/plugin) and [The Founding Reader](https://foundingreader.com). Connector listings and plugin bundles have separate review states; packaging a bundle does not mean its listing is approved.

The kit supports one public, unauthenticated, read-only HTTPS server. The server-design examples below describe our source libraries, not requirements for every MCP server. Authentication, write tools and multiple servers are outside this version's scope.

Both directories change their forms, limits and rules often. The specifics below were last checked against the official documentation on October 22, 2026. Reread it for the step you are on:

- OpenAI: [app review requirements](https://developers.openai.com/plugins/deploy/app-review), [submission](https://developers.openai.com/plugins/deploy/submission), [connecting to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt), [secure MCP tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- Anthropic: [plugin pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist), [submit a plugin](https://claude.com/docs/plugins/submit), [publish to the directory](https://claude.com/docs/directory/publish), [Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)

## Contents

1. [Design the server for review](#1-design-the-server-for-review)
2. [Harden the public endpoint](#2-harden-the-public-endpoint)
3. [Links are part of correctness](#3-links-are-part-of-correctness)
4. [Test in layers](#4-test-in-layers)
5. [Write review cases](#5-write-review-cases)
6. [Submit to the ChatGPT directory](#6-submit-to-the-chatgpt-directory)
7. [Submit to the Claude directory](#7-submit-to-the-claude-directory)
8. [Record the walkthrough](#8-record-the-walkthrough)
9. [Ship updates](#9-ship-updates)
10. [Pitfalls we hit](#10-pitfalls-we-hit)

## 1. Design the server for review

**Let the host model think; keep the server deterministic.** In both of our plugins, the assistant interprets the request, chooses search terms, compares candidates and writes the answer. The server only searches and returns exact text. It calls no model. That keeps per-call cost at hosting and bandwidth, makes results reproducible, and gives reviewers less to worry about.

**Start with the smallest tool set that covers the job.** The Stoic Library launched with two read-only tools (search, retrieve) and added a third (quote verification) only after launch. Each tool you add is another description to get right, another review case and another thing to test in both hosts.

**Write tool descriptions as factual documentation of inputs and outputs.** State what the tool does, accepted reference forms, bounds, continuation fields and how to read the result. Do not put model-behavior instructions in tool descriptions: no "always call X before Y", no directions about how to scope the conversation, no pointers to outside instruction sources. We rewrote all four Founding Reader descriptions this way before the Claude directory submission. Behavioral guidance belongs in the server's `instructions` (sent at initialize), which this kit also copies into the Claude skill.

**Set annotations truthfully.** A read-only lookup server is `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Annotations describe behavior; they are not access control.

**Return structured and text results, and keep outcomes distinct from failures.** Return `structuredContent` plus a text rendering. Use explicit statuses (`ok`, `candidates`, `not_found`, `invalid_reference`) and reserve `isError` for actual failures. A failure must never come back looking like a plausible result.

**Return identifiers the model can reuse.** Stable passage IDs, edition IDs, source version and canonical URLs let a follow-up call fetch exactly what the first call found, instead of rebuilding a reference from display text.

**Accept the units people actually ask for.** Our first version took only section references and rejected "Seneca Letter 1". Whole-unit lookup with pagination fixed it without losing precise section lookup.

**Bound long text and document the continuation fields.** We return 6,000 UTF-16 code units per page with a `next_offset`; the caller repeats the same ID and edition until `next_offset` is null. Write down what each flag means. Our `complete: false` on the last page means "this page alone is not the whole unit", which is not what the name suggests to a model reading it cold.

**On bad input, return the valid choices.** If the caller names an edition that does not exist, list the ones that do. Never substitute a different edition the caller did not ask for.

**Call search results candidates.** Every unrelated query in our evaluation still produced lexical matches. Label results as candidates and tell the model to reject unsuitable ones. An empty result is "not in this collection", never proof that something was never written.

**Treat retrieved text as data.** Say so in the instructions. Source documents can contain sentences that read like commands.

## 2. Harden the public endpoint

Stateless Streamable HTTP at `/mcp` with JSON responses (`enableJsonResponse: true`, no session ID generator) runs fine inside a serverless route. Our public handler applies these checks before the MCP transport sees the request:

| Check | Response |
| --- | --- |
| Host not in an allowlist | 403 |
| `Origin` present and not the site's own origin | 403 |
| Query string present | 400 |
| Method other than POST | 405 with `Allow: POST` |
| `Content-Type` not `application/json` | 415 |
| Body over a fixed cap (we use 32 KB) | 413, checked on the header and again while streaming |
| More than N requests per instance per minute | 429 with `Retry-After` |

Per-instance counters are not global quotas and not a spending cap. Say so in your own notes so nobody mistakes them for one.

Put the public route behind an environment flag, and keep it off until the pages and package that point at it are ready. When you turn it on, a new environment variable does not reach a running deployment on most hosts; redeploy, then probe the production hostname: initialize, `tools/list`, one real call per tool, a GET (expect 405) and a foreign `Origin` (expect 403).

Test the deployed bundle, not only a local Node process. Serverless bundlers drop data files they cannot see being imported; trace your corpus or data directory into the build explicitly.

If a CLI takes a token argument, assume it may echo the token in its output (one hosting CLI printed it inside a generated pagination hint). Capture and redact output before it reaches logs, transcripts or an assistant's context.

## 3. Links are part of correctness

Our first ChatGPT conversation quoted Elizabeth Carter's translation correctly and linked to a page that could open in a different translation, depending on the reader's saved preference. A caveat in the instructions did not fix it, because the model did not always repeat it. Making the link itself select the edition (`?translation=carter-1758`) did.

Test the destination's actual text, not just a 200 status or the presence of an anchor. Check first paint before hydration, saved preferences, and Back and Forward navigation. Ship the website change before the server starts emitting the new links.

## 4. Test in layers

Each layer proves something the others cannot. Keep their results separate; do not add counts from overlapping runs and call it coverage.

| Layer | Proves | Does not prove |
| --- | --- | --- |
| Unit and protocol tests with an MCP SDK client | Contracts, source fidelity, pagination, errors | Anything about a host model |
| MCP Inspector against the deployed endpoint | Real transport and each tool's real output | Tool choice by a model |
| Claude Code with the plugin loaded | Skill loading, tool choice and answers in Claude | claude.ai or ChatGPT behavior |
| An OpenAI model with the server mounted (Codex CLI, or a private ChatGPT connection) | OpenAI-model tool choice and argument handling | ChatGPT's own app routing |
| Real conversations in each product | What a user actually sees, including links | Broad usefulness or load behavior |

Useful commands:

```
# Inspector, one tool call against production
npx --yes @modelcontextprotocol/inspector --cli https://example.com/mcp \
  --transport http --method tools/call --tool-name get_source \
  --tool-arg 'reference=Chapter 1' --json

# Claude package checks
claude plugin validate --strict claude-plugin
claude -p --plugin-dir claude-plugin "Show me chapter 1."

# Codex as an OpenAI-model host, one fresh session per question
codex exec -s read-only \
  -c 'mcp_servers.myserver.url="http://127.0.0.1:3000/mcp"' \
  --skip-git-repo-check "The myserver tools are connected. Do not use the shell or read files. <question>"
```

To test the Claude package before the public endpoint exists, copy `claude-plugin/` somewhere temporary, point its `.mcp.json` at your local server, and run `claude -p --plugin-dir <copy> --allowedTools "mcp__plugin_<plugin>_<server>"`. Never commit that copy.

For a private ChatGPT connection before you have a public endpoint, OpenAI's secure MCP tunnel works. Create a dedicated tunnel associated with the right ChatGPT workspace, give its runtime key only the tunnel permissions it needs, and do not trust a green local health check: require successful polls and a real tool call from ChatGPT. After changing tool metadata, refresh the connection and start a new chat; restarting the server alone can leave cached descriptions.

## 5. Write review cases

Initial ChatGPT MCP review requires exactly five positive and three negative cases. This kit enforces those counts, writes the cases into `plugin.json`, and renders them into the Claude skill as expected behavior. These are prompts and expectations, not automatically executed evaluations. The public example is the spec of a package the ChatGPT directory accepted with exactly these counts.

- **Positive cases** should cover each tool, a follow-up that reuses returned IDs, a long source that needs pagination, and a named edition or version.
- **Negative cases** we used: an off-topic question the plugin should leave alone, a reference that does not exist (the model should say so, not invent text), and a request to read secrets or delete files.
- **Write `expected_behavior` to match what the recording shows.** One of our cases expected three documented responses; the recorded answer surfaced one. We relaxed the expectation to "at least one" so the manifest did not promise more than the video showed.
- Check every literal in the case text against the data. Edition IDs in the prose must be the exact IDs the tools accept.

## 6. Submit to the ChatGPT directory

In the order that worked:

1. **Publisher identity.** Individual verification lets you publish under your own name; business verification is needed to publish under a company name. The listing's developer name comes from the verified identity, not from your manifest. Wait until identity is approved, not just submitted.
2. **Public pages.** HTTPS product page, support contact, privacy policy and terms, all live. The product page needs little: links to the privacy policy and terms, plus a support contact. Name both assistant providers in the privacy policy if you ship to both.
3. **Package.** Upload a ZIP containing only `plugin.json`, `mcp.json` and the icon; this kit builds that ZIP from an explicit file list. Review metadata lives under `extensions.com.openai`. Set the category in `extensions.com.openai.interface.category` (ours is Education & Research). **The display name and the subtitle (`shortDescription`) are each limited to 30 characters.** Our second plugin's subtitle was rejected on first upload at 43. `validate` checks both, and requires exactly five positive and three negative review cases.
4. **Fix findings by re-uploading.** Fields that come from the ZIP are edited in the spec and re-uploaded to the same draft. An omitted field may keep its saved value while an explicit one is reapplied, so do not assume deleting a field clears it.
5. **Domain verification.** The portal shows a challenge token next to the challenge URL. Serve it as plain text at `/.well-known/openai-apps-challenge` on the endpoint's origin, check the raw HTTPS response, then click Verify Domain. Return only the token: no JSON, no list. Stage that route to return 404 until you have the real token. The token is a public ownership proof, not a credential. The challenge can also sit on an eligible parent domain, which helps when two plugins would otherwise share one challenge URL.
6. **Connect the MCP endpoint** with its real authentication mode (No Auth for a public read-only server).
7. **Walkthrough video.** Host it at a URL reviewers can open without signing in and put it in `extensions.com.openai.review.demo_recording_url`. See [section 8](#8-record-the-walkthrough).
8. **Save the affirmations.** The submission form has you tick a set of affirmations and data-practice questions, and neither directory shows your answers again. Copy each one word for word, with your answer, into the repo before you submit. Before any later change to what the endpoint collects or sends (analytics, logging, a third-party call), check it against that record. We skipped this on both plugins and later could not tell whether adding usage analytics would contradict what we had affirmed.
9. **Submit, and record the version, date and status.** Submission, approval and publication are three separate steps; after approval you still click Publish. Keep the endpoint, pages and video up and unchanged during review. Only one review can be active per plugin, so a corrected package waits for the decision unless you cancel the review. The Founding Reader's review took two days; the Stoic Library's took longer.

Listing limits checked against the [OpenAI field reference](https://developers.openai.com/plugins/deploy/submission) on October 22, 2026: `description` and `longDescription` allow 4,000 characters each; `author.name` supplies `developerName` and allows 80. Starter prompts allow up to three entries of 128 characters each; capabilities allow up to 20 entries of 120 characters each. Empty prompt and capability arrays are accepted. The kit validates these limits and requires `openai.demoRecordingUrl` because its supported MCP packages need a recording for review. These checks do not replace the portal's full validation.

## 7. Submit to the Claude directory

The Claude package needs no server changes: it points at the same remote endpoint (`.mcp.json` with `type: "http"`). The generated package contains `.claude-plugin/plugin.json`, a marketplace file, a skill built from the server's instructions and the review cases, a README, a license and the icon.

- **Use a dedicated public GitHub repo whose root is the `claude-plugin/` folder.** Anthropic's checklist applies stricter script rules and more reviewer holds to a plugin in a subfolder of a larger repo. `scripts/publish-claude-repo.sh` mirrors the folder and tags each version.
- **Run the portal's Validate before you submit.** In the developer portal (claude.ai/directory/manage), choose Plugin bundle, enter the repository, and select Validate. `claude plugin validate --strict` only checks that files are well formed; the portal also checks the README, license and name. The report covers one commit, so after pushing a fix, select Re-validate. After submission, a scan runs again on each new commit on the branch or tag the directory follows.
- **Pick a distinctive plugin name.** Lowercase letters, digits and hyphens, at most 64 characters. Reserved words such as `claude`, `anthropic`, `official`, `plugin`, `mcp` or `test` cannot be the whole name, and a name made only of generic words is held for a reviewer.
- **The README must say what the plugin sends.** The README needs at least 40 words outside code blocks, and the security scan looks for behavior the README does not disclose, such as sending data to an unlisted destination. Describe every piece of data that leaves the user's machine and where it goes. That is the `dataNotice` field in the spec.
- **Include a license.** The kit generates MIT; anything else needs `licenseFile`.
- **Give every repo its own marketplace name.** `claude plugin marketplace add` keys on the `name` inside `marketplace.json`, not on the repo. Our second plugin's repo reused the first one's marketplace name, which made the existing marketplace point at the second repo without any warning. Either use a distinct name per repo or one shared marketplace repo that lists every plugin.
- **A public plugin repo does nothing until the endpoint is live.** The package hard-codes the production `/mcp` URL. We published one repo while its route was still off, and the plugin failed every call for about an hour. Turn the endpoint on first.
- **Verify the install path from GitHub** with `claude plugin marketplace add <owner>/<repo>` and `claude plugin install <plugin>@<marketplace>`, then uninstall so your own sessions do not keep using it.
- **Check who can submit.** When we did it, Pro and Max users could submit from their own accounts; on Team and Enterprise plans an Owner submits.
- **The connector and the plugin bundle are reviewed separately.** For us the MCP server listing was published while the bundle was still waiting for a reviewer. The connector form asked for a self-test of every tool; MCP Inspector output against production served as that evidence. A person has to read the linked guidelines before ticking the acknowledgements.
- **Without the directory**, users can upload the generated `*-claude.zip` in claude.ai under Customize, Plugins, or load the folder with `claude --plugin-dir`.
- **With a published listing**, set `claude.directoryUrl` to its HTTPS URL. Generated README installation instructions then link to the listing. Leave it unset before a listing exists; ZIP generation and Claude Code installation instructions are unchanged.

## 8. Record the walkthrough

- Script it from your review cases, and type each prompt exactly as written in the manifest.
- Use a clean browser window: no unrelated tabs, bookmarks or notifications.
- Show the task, the answer and the page each link opens. For a source tool, show the attribution and that the linked page displays the same edition.
- If the answer leaves something out, check the raw tool result before you blame retrieval; it may be a presentation choice by the model.
- Edit out long waits and app switching. Keep the original and export an edited copy. Short labeled clips can cover a case the main take missed.
- Before submitting, confirm the hosted file downloads without signing in, has a video content type, and matches your final local file by checksum.
- Our edited videos ran about three and a half minutes.

## 9. Ship updates

- Change `version` in the spec for every release to either directory. Claude Code pins installs to that version.
- Put release notes in `openai.releaseNotes`. In ChatGPT, changes to metadata or bundled skills need a new ZIP and their own review. Changes to the hosted MCP server do not: after publication OpenAI scans the server daily and ships eligible changes once automated checks pass. Select Rescan under MCPs to check a deployment right away.
- Run `build --zip`, review the diff, commit, then mirror the Claude repo. Run `check` in CI so a stale package fails the build.
- Do not upload a new version while the previous one is still in review. We held one update until the first review finished.
- In Claude, every commit to the branch or tag the directory follows triggers a new scan, so release through tags rather than by pushing work in progress.
- If a new tool changes what the endpoint receives, update the privacy policy and its effective date in the same release, and check the change against your saved affirmations.
- A feature flag that registers the new tool only when set lets you merge the code, test it on a preview deployment, and keep production byte-identical until both listings are ready.

## 10. Pitfalls we hit

| Symptom | What it was |
| --- | --- |
| Subtitle rejected on first upload | ChatGPT limits `shortDescription` (and `displayName`) to 30 characters |
| Second plugin's install updated the first plugin | Two repos declared the same marketplace name |
| Public plugin failed every call | Repo published before the endpoint flag was on |
| Answer quoted the right text, link opened the wrong translation | Link depended on the reader's saved preference instead of selecting the edition |
| ChatGPT kept using old tool behavior | Cached metadata; refresh the connection and start a new chat |
| Tunnel reported ready, nothing connected | Health endpoint ignored control-plane auth failures; require a real call |
| Token appeared in CLI output | A hosting CLI echoed the `--token` argument; redact all captured output |
| Could not tell if analytics broke our submission promises | Nobody saved the affirmation answers |
| Endpoint worked locally, failed when deployed | Data files were not traced into the serverless bundle |
