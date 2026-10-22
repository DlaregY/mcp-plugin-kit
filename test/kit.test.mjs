import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTargets, drift, loadSpec, validate, write, zip } from "../src/index.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(repo, "examples/stoic-library");
const { spec, baseDir } = loadSpec(join(example, "plugin-src/spec.json"));

test("the example spec is valid", () => {
  assert.deepEqual(validate(spec), []);
});

test("directory installation replaces only the Claude README upload instruction", () => {
  const listed = structuredClone(spec);
  listed.claude.directoryUrl = "https://claude.ai/directory/example";
  const original = buildTargets(spec, { baseDir });
  const updated = buildTargets(listed, { baseDir });
  assert.match(updated.claude.files["README.md"], /\[Claude directory listing\]\(<https:\/\/claude.ai\/directory\/example>\)/);
  assert.doesNotMatch(updated.claude.files["README.md"], /upload the release ZIP/);
  assert.match(updated.claude.files["README.md"], /claude plugin marketplace add/);
  assert.match(original.claude.files["README.md"], /upload the release ZIP/);
  assert.deepEqual(updated.openai.files, original.openai.files);
  for (const name of Object.keys(original.claude.files).filter(name => name !== "README.md")) {
    assert.deepEqual(updated.claude.files[name], original.claude.files[name], name);
  }
});

test("directory URL must be a nonempty credential-free HTTPS URL", () => {
  for (const directoryUrl of ["", null, 42, "http://example.com", "https://user:password@example.com", "not a url"]) {
    const candidate = { ...spec, claude: { ...spec.claude, directoryUrl } };
    assert.ok(validate(candidate).some(problem => problem.startsWith("claude.directoryUrl")), String(directoryUrl));
  }
});

test("validate names each missing or malformed field", () => {
  const broken = { ...spec, name: "Bad Name", version: "1.0", mcp: { serverName: "x", url: "http://x" }, dataNotice: "" };
  delete broken.instructionsFile;
  const problems = validate(broken);
  for (const p of ["name must be kebab-case", "version must be MAJOR.MINOR.PATCH", "mcp.url must be https", "missing dataNotice", "missing instructions or instructionsFile"]) {
    assert.ok(problems.includes(p), p);
  }
  assert.throws(() => buildTargets(broken, { baseDir }), /Invalid plugin spec/);
});

test("a non-MIT license needs its own text", () => {
  assert.ok(validate({ ...spec, license: "Apache-2.0" }).some((p) => p.includes("licenseFile")));
});

test("both packages describe the same plugin and endpoint", () => {
  const out = mkdtempSync(join(tmpdir(), "kit-"));
  const targets = buildTargets(spec, { baseDir, outDir: out });
  write(targets);
  const read = (host, path) => readFileSync(join(targets[host].dir, path), "utf8");
  const openai = JSON.parse(read("openai", "plugin.json"));
  const claude = JSON.parse(read("claude", ".claude-plugin/plugin.json"));
  for (const key of ["name", "version", "description", "homepage", "author", "keywords"]) assert.deepEqual(claude[key], openai[key], key);
  const ui = openai.extensions["com.openai"].interface;
  assert.equal(claude.displayName, ui.displayName);
  assert.equal(claude.privacyPolicyUrl, ui.privacyPolicyURL);
  const o = JSON.parse(read("openai", "mcp.json")).mcpServers[spec.mcp.serverName];
  const c = JSON.parse(read("claude", ".mcp.json")).mcpServers[spec.mcp.serverName];
  assert.equal(o.type, "streamable-http");
  assert.equal(c.type, "http");
  assert.equal(c.url, o.url);
  const skill = read("claude", `skills/${spec.claude.skillName}/SKILL.md`);
  for (const rc of [...spec.reviewCases.positive, ...spec.reviewCases.negative]) assert.ok(skill.includes(rc.prompt), rc.prompt);
});

test("check reports an edited generated file", () => {
  const out = mkdtempSync(join(tmpdir(), "kit-"));
  const targets = buildTargets(spec, { baseDir, outDir: out });
  write(targets);
  assert.deepEqual(drift(targets), []);
  writeFileSync(join(targets.claude.dir, "README.md"), "edited by hand\n");
  assert.deepEqual(drift(targets), ["claude: README.md"]);
});

test("ZIPs are valid and byte-reproducible", () => {
  const targets = buildTargets(spec, { baseDir, outDir: mkdtempSync(join(tmpdir(), "kit-")) });
  const first = zip(targets, spec, mkdtempSync(join(tmpdir(), "kit-")));
  const second = zip(targets, spec, mkdtempSync(join(tmpdir(), "kit-")));
  for (const [i, host] of ["openai", "claude"].entries()) {
    assert.ok(readFileSync(first[i]).equals(readFileSync(second[i])));
    const listing = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('\\n'.join(z.namelist()))", first[i]], { encoding: "utf8" });
    assert.deepEqual(listing.trim().split("\n").sort(), Object.keys(targets[host].files).sort());
  }
});

test("CLI build then check round-trips in a fresh directory", () => {
  const work = mkdtempSync(join(tmpdir(), "kit-"));
  cpSync(join(example, "plugin-src"), join(work, "plugin-src"), { recursive: true });
  const cli = (...args) => execFileSync("node", [join(repo, "bin/mcp-plugin-kit.mjs"), ...args], { cwd: work, encoding: "utf8" });
  cli("build", "--zip");
  assert.match(cli("check"), /match/);
  writeFileSync(join(work, "plugin/mcp.json"), "{}\n");
  assert.throws(() => cli("check"), /stale/);
});

test("validate enforces ChatGPT listing limits", () => {
  const problems = validate({ ...spec, shortDescription: "x".repeat(31), reviewCases: { ...spec.reviewCases, negative: spec.reviewCases.negative.slice(0, 2) } });
  assert.ok(problems.some((p) => p.startsWith("shortDescription is 31")));
  assert.ok(problems.some((p) => p.startsWith("reviewCases.negative has 2")));
});
