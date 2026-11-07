import { lstatSync, realpathSync, readdirSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { writeZip } from "./zip.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Files that operating systems and file managers drop into folders; build and check ignore them, ZIPs and the publisher never include them. */
export const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const REQUIRED = [
  "name", "version", "displayName", "description", "shortDescription", "longDescription",
  "author.name", "author.email", "homepage", "license", "keywords",
  "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl", "icon",
  "mcp.serverName", "mcp.url", "toolsSummary", "dataNotice", "notFoundNotice",
  "capabilities", "starterPrompts", "reviewCases.positive", "reviewCases.negative",
  "openai.category", "openai.commerce", "openai.releaseNotes", "openai.demoRecordingUrl",
  "claude.repo", "claude.marketplace", "claude.marketplaceDescription",
  "claude.skillName", "claude.skillDescription",
];

/** The only nested metadata fields copied into generated manifests. */
const AUTHOR_FIELDS = ["name", "email", "url"];
const REVIEW_CASE_FIELDS = {
  positive: ["description", "prompt", "tools_triggered", "expected_behavior"],
  negative: ["description", "prompt", "expected_behavior"],
};

const pick = (obj, fields) => Object.fromEntries(Object.entries(obj).filter(([key]) => fields.includes(key)));

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** True when child is parent or sits below it. Compares paths only; pass physical paths to compare locations. */
const inside = (parent, child) => {
  const r = relative(parent, child);
  return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** Input files are published, so each must physically live in the spec's directory after symlinks resolve. */
function inputProblem(key, path, baseDir) {
  if (isAbsolute(path)) return `${key} must be a path relative to the spec file`;
  let data;
  try {
    const file = realpathSync(resolve(baseDir, path));
    if (!inside(realpathSync(baseDir), file)) return `${key} must be inside the spec file's directory after resolving symlinks; copy the file there`;
    if (!statSync(file).isFile()) throw new Error();
    data = readFileSync(file);
    if (!data.length) throw new Error();
  } catch { return `${key} must name a readable, nonempty file`; }
  if (key === "icon" && !data.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return "icon must be a PNG file";
}

/** Returns a list of problems; an empty list means the spec can be built. */
export function validate(spec, { baseDir } = {}) {
  const problems = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["spec must be an object"];
  const arrays = ["keywords", "capabilities", "starterPrompts", "reviewCases.positive", "reviewCases.negative"];
  for (const key of ["author", "mcp", "openai", "claude", "reviewCases", "output"]) {
    if (spec[key] !== undefined && (!spec[key] || typeof spec[key] !== "object" || Array.isArray(spec[key]))) problems.push(`${key} must be an object`);
  }
  for (const key of Object.keys(spec.mcp ?? {})) {
    if (!["serverName", "url"].includes(key)) problems.push(`mcp.${key} is unsupported; this version supports one unauthenticated read-only server`);
  }
  for (const key of Object.keys(spec.author ?? {})) {
    if (!AUTHOR_FIELDS.includes(key)) problems.push(`author.${key} is unsupported; allowed fields are ${AUTHOR_FIELDS.join(", ")}`);
  }
  for (const path of REQUIRED) {
    const v = get(spec, path);
    if (v === undefined || v === null || v === "") problems.push(`missing ${path}`);
    else if (arrays.includes(path)) {
      if (!Array.isArray(v)) problems.push(`${path} must be an array`);
      else if (!path.startsWith("reviewCases.") && ((path === "keywords" && !v.length) || v.some(x => typeof x !== "string" || !x.trim()))) problems.push(`${path} must contain nonempty strings`);
    } else if (path === "openai.commerce") {
      if (typeof v !== "boolean") problems.push(`${path} must be a boolean`);
    } else if (typeof v !== "string" || !v.trim()) problems.push(`${path} must be a nonempty string`);
  }
  for (const path of ["instructions", "instructionsFile", "licenseFile", "readmeToolsSummary", "openai.demoRecordingUrl", "openai.commerceDescription", "claude.directoryUrl"]) {
    const v = get(spec, path);
    if (v !== undefined && (typeof v !== "string" || !v.trim())) problems.push(`${path} must be a nonempty string`);
  }
  for (const path of ["author.url", "homepage", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl", "mcp.url", "openai.demoRecordingUrl", "claude.directoryUrl"]) {
    const v = get(spec, path);
    if (v !== undefined) {
      try { const u = new URL(v); if (u.protocol !== "https:" || !u.hostname || u.username || u.password) throw new Error(); }
      catch { problems.push(`${path} must be a valid HTTPS URL without credentials`); }
    }
  }
  if (spec.claude?.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec.claude.repo)) problems.push("claude.repo must be owner/repository");
  for (const host of ["openai", "claude"]) {
    if (spec.output?.[host] !== undefined && !safePath(spec.output[host])) problems.push(`output.${host} must be a relative subdirectory without dot segments`);
  }
  if (spec.copyrightYear !== undefined && (!Number.isInteger(spec.copyrightYear) || spec.copyrightYear < 1970)) problems.push("copyrightYear must be an integer year");
  if (spec.license === "MIT" && spec.copyrightYear === undefined) problems.push("missing copyrightYear (required for reproducible MIT output)");
  if (baseDir !== undefined) {
    for (const key of ["icon", "instructionsFile", "licenseFile"]) {
      if (typeof spec[key] !== "string") continue;
      const problem = inputProblem(key, spec[key], baseDir);
      if (problem) problems.push(problem);
    }
  }
  if (spec.instructions === undefined && spec.instructionsFile === undefined) {
    problems.push("missing instructions or instructionsFile");
  }
  if (spec.license && spec.license !== "MIT" && !spec.licenseFile) {
    problems.push(`license ${spec.license} needs licenseFile (MIT is generated)`);
  }
  if (spec.name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec.name)) problems.push("name must be kebab-case");
  if (spec.claude?.skillName && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(spec.claude.skillName)) {
    problems.push("claude.skillName must be kebab-case");
  }
  if (spec.version && !/^\d+\.\d+\.\d+$/.test(spec.version)) problems.push("version must be MAJOR.MINOR.PATCH");
  if (spec.mcp?.url && !/^https:\/\//.test(spec.mcp.url)) problems.push("mcp.url must be https");
  for (const [kind, cases] of Object.entries(spec.reviewCases ?? {})) {
    const fields = Object.hasOwn(REVIEW_CASE_FIELDS, kind) ? REVIEW_CASE_FIELDS[kind] : undefined;
    if (!fields) { problems.push(`reviewCases.${kind} is unsupported; allowed groups are positive, negative`); continue; }
    if (!Array.isArray(cases)) continue;
    cases.forEach((c, i) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) { problems.push(`reviewCases.${kind}[${i}] must be an object`); return; }
      for (const k of Object.keys(c)) {
        if (!fields.includes(k)) problems.push(`reviewCases.${kind}[${i}].${k} is unsupported; allowed fields are ${fields.join(", ")}`);
      }
      for (const k of ["description", "prompt", "expected_behavior"]) {
        if (typeof c[k] !== "string" || !c[k].trim()) problems.push(`reviewCases.${kind}[${i}] missing ${k}`);
      }
      if (kind === "positive" && (typeof c.tools_triggered !== "string" || !c.tools_triggered.trim())) problems.push(`reviewCases.positive[${i}] missing tools_triggered`);
    });
  }
  for (const [path, limit] of [["displayName", 30], ["shortDescription", 30], ["description", 4000], ["longDescription", 4000], ["author.name", 80]]) {
    const value = get(spec, path);
    if (typeof value === "string" && value.length > limit) problems.push(`${path} is ${value.length} characters; ChatGPT allows ${limit}`);
  }
  for (const [path, count, length] of [["starterPrompts", 3, 128], ["capabilities", 20, 120]]) {
    const values = spec[path];
    if (!Array.isArray(values)) continue;
    if (values.length > count) problems.push(`${path} has ${values.length} entries; ChatGPT allows ${count}`);
    values.forEach((value, i) => {
      if (typeof value === "string" && value.length > length) problems.push(`${path}[${i}] is ${value.length} characters; ChatGPT allows ${length}`);
    });
  }
  if (spec.name && spec.name.length > 64) problems.push("name must be 64 characters or fewer");
  for (const [kind, n] of [["positive", 5], ["negative", 3]]) {
    const count = spec.reviewCases?.[kind]?.length ?? 0;
    if (count !== n) problems.push(`reviewCases.${kind} has ${count} cases; ChatGPT review requires exactly ${n}`);
  }
  if (spec.openai?.commerce && !spec.openai.commerceDescription) problems.push("openai.commerce needs commerceDescription");
  return problems;
}

/** Reads a spec file; relative paths inside it (icon, instructionsFile, licenseFile) resolve from its directory. */
export function loadSpec(specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  return { spec, baseDir: dirname(resolve(specPath)) };
}

function openaiFiles(s, icon) {
  const testCases = Object.fromEntries(Object.entries(REVIEW_CASE_FIELDS).map(([kind, fields]) => [kind, s.reviewCases[kind].map((c) => pick(c, fields))]));
  return {
    "plugin.json": json({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: s.name, version: s.version, description: s.description, author: pick(s.author, AUTHOR_FIELDS),
      homepage: s.homepage, keywords: s.keywords,
      extensions: { "com.openai": {
        interface: {
          displayName: s.displayName, shortDescription: s.shortDescription, longDescription: s.longDescription,
          developerName: s.author.name, category: s.openai.category, capabilities: s.capabilities,
          websiteURL: s.homepage, supportURL: s.supportUrl, privacyPolicyURL: s.privacyPolicyUrl,
          termsOfServiceURL: s.termsOfServiceUrl, defaultPrompt: s.starterPrompts,
          logo: "./assets/icon.png", composerIcon: "./assets/icon.png",
        },
        review: {
          demo_recording_url: s.openai.demoRecordingUrl, test_cases: testCases,
          commerce: s.openai.commerce, commerce_description: s.openai.commerceDescription,
        },
        publication: { release_notes: s.openai.releaseNotes },
      } },
    }),
    "mcp.json": json({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [s.mcp.serverName]: { type: "streamable-http", url: s.mcp.url } },
    }),
    "assets/icon.png": { copy: icon },
  };
}

function skill(s, instructions) {
  const positive = s.reviewCases.positive.map((c) => `- "${c.prompt}" (${c.tools_triggered}): ${c.expected_behavior}`);
  const negative = s.reviewCases.negative.map((c) => `- "${c.prompt}": ${c.expected_behavior}`);
  return `---
name: ${s.claude.skillName}
description: ${JSON.stringify(s.claude.skillDescription)}
---

# ${s.displayName}

${s.longDescription}

The \`${s.mcp.serverName}\` connector provides ${s.toolsSummary}

## Operating rules

${instructions}

## Expected behavior

${positive.join("\n")}

## Do not use the tools for

${negative.join("\n")}
`;
}

function readme(s) {
  return `# ${s.displayName}

${s.longDescription}

This plugin bundles one remote MCP connector and one skill. The connector points to \`${s.mcp.url}\`, a public, read-only, no-authentication endpoint operated by ${s.author.name}. It exposes ${s.readmeToolsSummary ?? s.toolsSummary} The skill describes when to use the tools and how to interpret their results.

## What the plugin sends and receives

${s.dataNotice}

Privacy policy: ${s.privacyPolicyUrl}
Terms: ${s.termsOfServiceUrl}
Support: ${s.supportUrl} (${s.author.email})

## Install

In Claude Code:

\`\`\`
claude plugin marketplace add ${s.claude.repo}
claude plugin install ${s.name}@${s.claude.marketplace}
\`\`\`

${s.claude.directoryUrl
    ? `In Claude chat or Cowork, install from the [Claude directory listing](<${new URL(s.claude.directoryUrl).href.replace(/</g, "%3C").replace(/>/g, "%3E")}>).`
    : "In Claude chat or Cowork, upload the release ZIP under Customize > Plugins > Upload plugin."}

## Try it

${s.starterPrompts.map((p) => `- ${p}`).join("\n")}

${s.notFoundNotice}
`;
}

function mitLicense(holder, year) {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

function claudeFiles(s, icon, instructions, licenseText) {
  return {
    ".claude-plugin/plugin.json": json({
      name: s.name, displayName: s.displayName, version: s.version, description: s.description,
      author: pick(s.author, AUTHOR_FIELDS), homepage: s.homepage, license: s.license, keywords: s.keywords,
      icon: "./assets/icon.png", documentationUrl: s.homepage, supportUrl: s.supportUrl,
      privacyPolicyUrl: s.privacyPolicyUrl, termsOfServiceUrl: s.termsOfServiceUrl,
    }),
    ".claude-plugin/marketplace.json": json({
      name: s.claude.marketplace, owner: { name: s.author.name, email: s.author.email },
      description: s.claude.marketplaceDescription,
      plugins: [{ name: s.name, source: "./", description: s.description }],
    }),
    ".mcp.json": json({ mcpServers: { [s.mcp.serverName]: { type: "http", url: s.mcp.url } } }),
    [`skills/${s.claude.skillName}/SKILL.md`]: skill(s, instructions),
    "README.md": readme(s),
    "LICENSE": licenseText,
    "assets/icon.png": { copy: icon },
  };
}

/**
 * Builds the file maps for both hosts without writing to disk.
 * outDir defaults to the parent of baseDir, so a spec in plugin-src/ writes beside it, as the CLI does.
 * options.instructions overrides spec.instructions / instructionsFile, so a server can pass
 * the exact string it serves and the skill cannot drift from it.
 */
export function buildTargets(spec, { baseDir = ".", outDir = resolve(baseDir, ".."), instructions } = {}) {
  const problems = validate({ ...spec, ...(instructions !== undefined && { instructions }) }, { baseDir });
  if (problems.length) throw new Error(`Invalid plugin spec:\n- ${problems.join("\n- ")}`);
  const at = (p) => realpathSync(resolve(baseDir, p));
  const text = instructions ?? spec.instructions ?? readFileSync(at(spec.instructionsFile), "utf8").trim();
  const licenseText = spec.license === "MIT"
    ? mitLicense(spec.copyrightHolder ?? spec.author.name, spec.copyrightYear)
    : readFileSync(at(spec.licenseFile), "utf8");
  const icon = at(spec.icon);
  const targets = {
    openai: { dir: join(outDir, spec.output?.openai ?? "plugin"), files: openaiFiles(spec, icon) },
    claude: { dir: join(outDir, spec.output?.claude ?? "claude-plugin"), files: claudeFiles(spec, icon, text, licenseText) },
  };
  checkTargets(targets);
  return targets;
}

function safePath(p) {
  return typeof p === "string" && p.length > 0 && !isAbsolute(p) && !p.includes("\\") && p.split("/").every(x => x && x !== "." && x !== ".." && x !== ".git");
}

function noLinks(path, root) {
  let p = resolve(path);
  while (true) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error(`Symlink not allowed: ${p}`); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    if (p === resolve(root)) break;
    p = dirname(p);
  }
}

function realDestination(path) {
  try { return realpathSync(path); }
  catch (e) {
    if (e.code !== "ENOENT") throw e;
    return join(realDestination(dirname(path)), relative(dirname(path), path));
  }
}

function checkTargets(targets) {
  const dirs = Object.values(targets).map(t => {
    noLinks(t.dir, t.dir);
    return realDestination(resolve(t.dir));
  });
  for (let i = 0; i < dirs.length; i++) {
    if (dirname(dirs[i]) === dirs[i]) throw new Error("Output cannot be a filesystem root");
    for (let j = 0; j < i; j++) {
      if (inside(dirs[i], dirs[j]) || inside(dirs[j], dirs[i])) throw new Error("Output directories must not overlap");
    }
  }
  for (const { dir, files } of Object.values(targets)) for (const path of Object.keys(files)) {
    if (!safePath(path)) throw new Error(`Unsafe output file: ${path}`);
    noLinks(join(dir, path), dir);
    let p = resolve(dir, path);
    const destination = p;
    while (true) {
      try {
        const stat = lstatSync(p);
        if (p === destination ? (!stat.isFile() || stat.nlink > 1) : !stat.isDirectory()) throw new Error(`Unsafe destination: ${p}`);
      } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (p === resolve(dir)) break;
      p = dirname(p);
    }
  }
}

function diskFiles(dir, prefix = "") {
  let entries;
  try { entries = readdirSync(join(dir, prefix), { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  return entries.flatMap(e => {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return diskFiles(dir, p);
    return OS_JUNK.has(e.name) ? [] : [p];
  });
}

const contents = (entry) => (typeof entry === "string" ? Buffer.from(entry) : readFileSync(entry.copy));

/** Lists generated files whose committed copy is missing or differs. */
export function drift(targets) {
  checkTargets(targets);
  const stale = [];
  for (const [host, { dir, files }] of Object.entries(targets)) {
    for (const path of diskFiles(dir)) if (!Object.hasOwn(files, path)) stale.push(`${host}: unexpected ${path}`);
    for (const [path, entry] of Object.entries(files)) {
      let current;
      try { current = readFileSync(join(dir, path)); } catch { current = null; }
      if (!current || !current.equals(contents(entry))) stale.push(`${host}: ${path}`);
    }
  }
  return stale;
}

/** Preflights every input and destination before overwriting generated files. Never deletes directories. */
export function write(targets) {
  checkTargets(targets);
  const prepared = Object.values(targets).map(({ dir, files }) => {
    const extra = diskFiles(dir).filter(p => !Object.hasOwn(files, p));
    if (extra.length) throw new Error(`Unexpected files in ${dir}; move them before building: ${extra.join(", ")}`);
    return { dir, files: Object.entries(files).map(([p, entry]) => [p, contents(entry)]) };
  });
  for (const { dir, files } of prepared) {
    for (const [path, data] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), data);
    }
  }
}

/** Preflights ZIP destinations and returns their paths. Call before write() so a bad destination stops the build before any file changes. */
export function checkArchives(targets, spec, outDir) {
  noLinks(outDir, outDir);
  const archives = Object.keys(targets).map((host) => join(outDir, `${spec.name}-${spec.version}-${host}.zip`));
  for (const archive of archives) {
    const file = realDestination(resolve(archive));
    for (const { dir } of Object.values(targets)) {
      const real = realDestination(resolve(dir));
      if (inside(real, file) || inside(file, real)) throw new Error(`ZIP ${archive} overlaps package directory ${dir}; change output.openai, output.claude or the ZIP folder`);
    }
    try {
      const stat = lstatSync(archive);
      if (!stat.isFile() || stat.nlink > 1) throw new Error(`Unsafe destination: ${archive}`);
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return archives;
}

/** Writes one upload ZIP per host and returns their paths. Refuses a symlinked ZIP folder or archive path, and any overlap with a package directory. */
export function zip(targets, spec, outDir) {
  const archives = checkArchives(targets, spec, outDir);
  mkdirSync(outDir, { recursive: true });
  return Object.entries(targets).map(([host, { files }], i) => {
    writeZip(archives[i], Object.entries(files).map(([name, entry]) => ({ name, data: contents(entry) })));
    return archives[i];
  });
}
