import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, cpSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildTargets, drift, loadSpec, validate, write, zip } from "../src/index.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { spec, baseDir } = loadSpec(join(repo, "examples/stoic-library/plugin-src/spec.json"));
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "kit-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("malformed input returns diagnostics instead of crashing", () => {
  for (const s of [null, [], 3, {...spec, starterPrompts: 42}, {...spec, keywords: 7}, {...spec, reviewCases: {positive: {}, negative: [null]}}, {...spec, mcp: {url: "https://"}}, {...spec, openai: {...spec.openai, commerce: "false"}}]) {
    assert.ok(validate(s).length);
  }
  assert.ok(validate({...spec, reviewCases: {...spec.reviewCases, positive: [...spec.reviewCases.positive, spec.reviewCases.positive[0]]}}).length);
  assert.ok(validate({...spec, copyrightYear: undefined}).length);
  assert.ok(validate({...spec, icon: "missing.png"}, {baseDir}).some(x => x.includes("readable")));
});

test("output traversal and overlap are rejected before writes", t => {
  const outDir = temporary(t);
  for (const path of ["..", ".", "../escape", "/tmp", "a/../b", ".git", "a\\b"]) {
    assert.throws(() => buildTargets({...spec, output: {openai: path}}, {baseDir, outDir}), /relative subdirectory/);
  }
  for (const output of [{openai: "same", claude: "same"}, {openai: "a", claude: "a/b"}]) {
    assert.throws(() => buildTargets({...spec, output}, {baseDir, outDir}), /overlap/);
  }
});

test("extra files fail check and survive a refused build", t => {
  const targets = buildTargets(spec, {baseDir, outDir: temporary(t)});
  write(targets);
  const extra = join(targets.claude.dir, "old-hook.sh");
  writeFileSync(extra, "keep me");
  assert.ok(drift(targets).includes("claude: unexpected old-hook.sh"));
  assert.throws(() => write(targets), /Unexpected files/);
  assert.equal(readFileSync(extra, "utf8"), "keep me");
});

test("missing inputs and invalid destinations preserve previously written files", t => {
  const targets = buildTargets(spec, {baseDir, outDir: temporary(t)});
  write(targets);
  const saved = join(targets.openai.dir, "plugin.json");
  writeFileSync(saved, "original");
  targets.claude.files["assets/icon.png"] = {copy: "/nonexistent-kit-test/icon.png"};
  assert.throws(() => write(targets), /ENOENT/);
  assert.equal(readFileSync(saved, "utf8"), "original");
  targets.claude.files["assets/icon.png"] = {copy: join(baseDir, "icon.png")};
  targets.claude.files["assets"] = "not a directory";
  assert.throws(() => write(targets), /Unsafe destination/);
  assert.equal(readFileSync(saved, "utf8"), "original");
});

test("symlink outputs cannot overwrite their targets", t => {
  const outDir = temporary(t);
  const elsewhere = temporary(t);
  symlinkSync(elsewhere, join(outDir, "plugin"));
  assert.throws(() => buildTargets(spec, {baseDir, outDir}), /Symlink/);
  const targets = buildTargets(spec, {baseDir, outDir: elsewhere});
  write(targets);
  const victim = join(outDir, "victim");
  writeFileSync(victim, "protected");
  rmSync(join(targets.claude.dir, "README.md"));
  symlinkSync(victim, join(targets.claude.dir, "README.md"));
  assert.throws(() => write(targets), /Symlink/);
  assert.equal(readFileSync(victim, "utf8"), "protected");
});

test("symlinked parent folders support build and check without weakening output guards", t => {
  const root = temporary(t);
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  mkdirSync(actual);
  symlinkSync(actual, alias);
  cpSync(baseDir, join(actual, "plugin-src"), {recursive: true});
  const loaded = loadSpec(join(alias, "plugin-src/spec.json"));
  const outDir = join(alias, "new", "nested");
  const targets = buildTargets(loaded.spec, {...loaded, outDir});
  write(targets);
  assert.deepEqual(drift(targets), []);
  const victim = join(root, "victim");
  writeFileSync(victim, "protected");
  rmSync(join(targets.claude.dir, "assets"), {recursive: true});
  symlinkSync(root, join(targets.claude.dir, "assets"));
  assert.throws(() => write(targets), /Symlink/);
  assert.equal(readFileSync(victim, "utf8"), "protected");
  assert.throws(() => write({
    openai: {dir: join(actual, "shared"), files: {"a": "a"}},
    claude: {dir: join(alias, "shared", "nested"), files: {"b": "b"}},
  }), /overlap/);
});

test("listing validation accepts boundaries and rejects each excess or missing recording", () => {
  const boundary = {...spec, description: "x".repeat(4000), longDescription: "x".repeat(4000),
    author: {...spec.author, name: "x".repeat(80)},
    starterPrompts: ["a", "b", "c"].map(x => x.repeat(128)),
    capabilities: Array.from({length: 20}, (_, i) => String(i).padEnd(120, "x"))};
  assert.deepEqual(validate(boundary), []);
  assert.deepEqual(validate({...spec, starterPrompts: [], capabilities: []}), []);
  for (const [change, field] of [
    [{description: "x".repeat(4001)}, "description"],
    [{longDescription: "x".repeat(4001)}, "longDescription"],
    [{author: {...spec.author, name: "x".repeat(81)}}, "author.name"],
    [{starterPrompts: ["a", "b", "c", "d"]}, "starterPrompts"],
    [{starterPrompts: ["x".repeat(129)]}, "starterPrompts[0]"],
    [{capabilities: Array(21).fill("a")}, "capabilities"],
    [{capabilities: ["x".repeat(121)]}, "capabilities[0]"],
    [{openai: {...spec.openai, demoRecordingUrl: undefined}}, "openai.demoRecordingUrl"],
    [{openai: {...spec.openai, demoRecordingUrl: ""}}, "openai.demoRecordingUrl"],
  ]) assert.ok(validate({...spec, ...change}).some(p => p.includes(field)), field);
});

test("generic read-only server copy has no quotation assumptions", () => {
  const targets = buildTargets({...spec, name: "weather-data", displayName: "Weather data", toolsSummary: "a weather lookup tool.", readmeToolsSummary: "a weather lookup tool."}, {baseDir});
  assert.match(targets.claude.files["README.md"], /how to interpret their results/);
  assert.doesNotMatch(targets.claude.files["README.md"], /how to quote, attribute/);
});

test("publisher honors custom output and refuses conflicting tags without changing remote", t => {
  const root = temporary(t);
  const env = {...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1"};
  const git = (args, cwd = root) => execFileSync("git", args, {cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
  const remote = join(root, "remote.git");
  git(["init", "--bare", "-b", "main", remote]);
  git(["clone", remote, "seed"]);
  writeFileSync(join(root, "seed/README.md"), "initial");
  git(["add", "."], join(root, "seed"));
  git(["commit", "-m", "Initial"], join(root, "seed"));
  git(["push", "origin", "main"], join(root, "seed"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/gh"), '#!/bin/sh\nexec git clone -q "$TEST_REMOTE" "$4"\n');
  chmodSync(join(root, "bin/gh"), 0o755);
  env.PATH = `${join(root, "bin")}:${env.PATH}`;
  env.TEST_REMOTE = remote;
  cpSync(baseDir, join(root, "plugin-src"), {recursive: true});
  const specPath = join(root, "plugin-src/spec.json");
  const s = {...spec, output: {openai: "packages/openai", claude: "packages/claude"}};
  const outDir = join(root, "built");
  const build = () => {
    writeFileSync(specPath, JSON.stringify(s));
    write(buildTargets(s, {baseDir: join(root, "plugin-src"), outDir}));
  };
  const publish = () => execFileSync("bash", [join(repo, "scripts/publish-claude-repo.sh"), specPath, outDir], {env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
  build();
  writeFileSync(join(outDir, "packages/claude/.DS_Store"), "junk");
  assert.match(publish(), /Published/);
  const head = git(["--git-dir", remote, "rev-parse", "main"]);
  assert.ok(!git(["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).includes(".DS_Store"));
  assert.equal(git(["--git-dir", remote, "rev-parse", `v${s.version}`]), head);
  assert.match(publish(), /already contains/);
  s.toolsSummary = "changed tools";
  build();
  assert.throws(publish, /already exists with different content/);
  assert.equal(git(["--git-dir", remote, "rev-parse", "main"]), head);
});

test("file-manager junk is ignored by check and build, excluded from ZIPs and removed by the publisher", t => {
  const outDir = temporary(t);
  const targets = buildTargets(spec, {baseDir, outDir});
  write(targets);
  writeFileSync(join(targets.claude.dir, ".DS_Store"), "junk");
  writeFileSync(join(targets.openai.dir, "assets", "Thumbs.db"), "junk");
  assert.deepEqual(drift(targets), []);
  assert.doesNotThrow(() => write(targets));
  assert.equal(readFileSync(join(targets.claude.dir, ".DS_Store"), "utf8"), "junk");
  const [, claudeZip] = zip(targets, spec, join(outDir, "output"));
  const listing = execFileSync("python3", ["-c", "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", claudeZip], {encoding: "utf8"});
  assert.ok(!listing.includes(".DS_Store"));
});

test("zip refuses a symlinked archive folder", t => {
  const outDir = temporary(t);
  const elsewhere = temporary(t);
  const targets = buildTargets(spec, {baseDir, outDir});
  symlinkSync(elsewhere, join(outDir, "output"));
  assert.throws(() => zip(targets, spec, join(outDir, "output")), /Symlink/);
});
