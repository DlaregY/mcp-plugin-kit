# AGENTS.md

Guidance for people and coding agents changing this repo.

- Run `npm test` before every commit. `test/reproduce.test.mjs` compares the complete generated output with the committed public example, and the ChatGPT files with `test/fixtures/stoic-library-1.0.1-openai/`, the package the directory accepted. A change that alters generated output is a behavior change: say why in the commit and review the fixture diff. The frozen fixture must never be regenerated; if the ChatGPT output has to change, add a new fixture from a newly accepted package.
- Zero dependencies. Node 20 or later. Generated files and ZIPs must stay byte-reproducible so `check` works in CI.
- Rules taken from a directory's requirements belong in `validate`, with the limit in the message, and in `docs/GUIDE.md` with the date they were checked.
- Prose style for the README and guide: plain, specific sentences; no em dashes.
- Never commit credentials, tokens or private endpoints, including in examples.
