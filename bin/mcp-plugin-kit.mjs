#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildTargets, drift, loadSpec, validate, write, zip } from "../src/index.mjs";

const usage = `Usage: mcp-plugin-kit <build|check|validate> [--spec plugin-src/spec.json] [--out DIR] [--zip]

  build     Write the ChatGPT package (plugin/) and the Claude package (claude-plugin/)
  check     Exit 1 if the committed packages differ from what the spec generates
  validate  Report missing or malformed spec fields

  --spec    Spec file (default plugin-src/spec.json)
  --out     Directory that receives plugin/, claude-plugin/ and output/ (default: the spec's parent directory)
  --zip     With build, also write one upload ZIP per host to <out>/output/`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { spec: { type: "string", default: "plugin-src/spec.json" }, out: { type: "string" }, zip: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const command = positionals[0];
if (values.help || !["build", "check", "validate"].includes(command)) {
  console.log(usage);
  process.exit(values.help ? 0 : 2);
}

try {
  const { spec, baseDir } = loadSpec(values.spec);
  if (command === "validate") {
    const problems = validate(spec, { baseDir });
    if (problems.length) { console.error(problems.map((p) => `- ${p}`).join("\n")); process.exit(1); }
    console.log(`${values.spec} is valid`);
    process.exit(0);
  }
  const outDir = values.out ?? join(baseDir, "..");
  const targets = buildTargets(spec, { baseDir, outDir });
  if (command === "check") {
    const stale = drift(targets);
    if (stale.length) { console.error(`Generated plugin files are stale; run mcp-plugin-kit build\n${stale.join("\n")}`); process.exit(1); }
    console.log(`Plugin packages match ${values.spec}`);
  } else {
    write(targets);
    console.log(`Wrote ${targets.openai.dir} (ChatGPT) and ${targets.claude.dir} (Claude)`);
    if (values.zip) for (const z of zip(targets, spec, join(outDir, "output"))) console.log(z);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
