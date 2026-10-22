#!/usr/bin/env bash
# Mirror a generated claude-plugin/ into its public GitHub repo (spec.claude.repo) and tag the spec version.
# Usage: publish-claude-repo.sh [path/to/plugin-src/spec.json] [output-root]
set -euo pipefail
kit="$(cd "$(dirname "$0")/.." && pwd)"
spec="$(cd "$(dirname "${1:-plugin-src/spec.json}")" && pwd)/$(basename "${1:-plugin-src/spec.json}")"
root="$(dirname "$(dirname "$spec")")"
out="${2:-$root}"
node "$kit/bin/mcp-plugin-kit.mjs" check --spec "$spec" --out "$out"
source_dir="$(node --input-type=module -e 'const {loadSpec,buildTargets}=await import(process.argv[1]);const {spec,baseDir}=loadSpec(process.argv[2]);console.log(buildTargets(spec,{baseDir,outDir:process.argv[3]}).claude.dir)' "$kit/src/index.mjs" "$spec" "$out")"
source_dir="$(cd "$source_dir" && pwd)"
repo="$(node -e 'console.log(require(process.argv[1]).claude.repo)' "$spec")"
version="$(node -e 'console.log(require(process.argv[1]).version)' "$spec")"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
gh repo clone "$repo" "$work/repo" -- -q
find "$work/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$source_dir/." "$work/repo/"
find "$work/repo" -path "$work/repo/.git" -prune -o -type f \( -name .DS_Store -o -name Thumbs.db -o -name desktop.ini \) -print0 | xargs -0 -r rm -f
cd "$work/repo"
git add -A
tree="$(git write-tree)"
if git show-ref --verify --quiet "refs/tags/v$version"; then
  if [ "$(git rev-parse "v$version^{tree}")" != "$tree" ]; then
    echo "Version v$version already exists with different content; bump the spec version." >&2
    exit 1
  fi
  echo "$repo v$version already contains the exact package"
  exit 0
fi
if git diff --cached --quiet; then echo "$repo already matches package ($version)"; else
  git commit -q -m "Release $version"
fi
git tag "v$version"
git push --atomic -q origin HEAD "refs/tags/v$version"
echo "Published $repo at v$version"
