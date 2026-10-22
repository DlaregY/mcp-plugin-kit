import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTargets, drift, loadSpec } from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../examples/stoic-library");
const { spec, baseDir } = loadSpec(join(root, "plugin-src/spec.json"));

test("reproduces the committed public example, including the complete file list", () => {
  assert.deepEqual(drift(buildTargets(spec, { baseDir, outDir: root })), []);
});

test("rebuilds the ChatGPT package the directory accepted (The Stoic Library 1.0.1) byte for byte", () => {
  const { files } = buildTargets(spec, { baseDir, outDir: root }).openai;
  for (const name of ["plugin.json", "mcp.json"]) {
    assert.equal(files[name], readFileSync(join(here, "fixtures/stoic-library-1.0.1-openai", name), "utf8"), name);
  }
});
