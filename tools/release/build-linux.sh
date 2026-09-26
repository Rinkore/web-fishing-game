#!/usr/bin/env bash
# Build the Linux release from a clean checkout. Does not publish or deploy.
set -euo pipefail

version="${1:?Usage: build-linux.sh vX.Y.Z [output-directory]}"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release version' >&2; exit 2; }
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"
output="${2:-$root/output/release}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
source_commit="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=all -- server-go frontend)" ]]; then
  echo 'Release sources must be a clean checkout of the selected commit' >&2
  exit 1
fi
actual_version="$(node -e "process.stdout.write(require('./frontend/js/data.js').VERSION)")"
[[ "$actual_version" == "$version" ]] || { echo 'Tag and frontend version differ' >&2; exit 1; }

migrations_sha256="$(node tools/release/migration-hash.js)"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/licenses"
for command in game migrate catalog admin reset; do
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C server-go build -trimpath -buildvcs=false \
    -o "$stage/bin/$command" "./cmd/$command"
done
git archive "$source_commit" frontend | tar -x -C "$stage"
cp server-go/THIRD_PARTY_NOTICES.md "$stage/licenses/THIRD_PARTY_NOTICES.md"
cp "$(go env GOROOT)/LICENSE" "$stage/licenses/GO_LICENSE.txt"
printf '%s\n' "$source_commit" > "$stage/SOURCE_COMMIT.txt"
printf '%s\n' "$migrations_sha256" > "$stage/MIGRATIONS_SHA256.txt"
printf '%s\n' "$version" > "$stage/VERSION.txt"
asset='web-fishing-game-linux-amd64.tar.gz'
tar --sort=name --mtime="@$(git show -s --format=%ct "$source_commit")" \
  --owner=0 --group=0 --numeric-owner -czf "$output/$asset" -C "$stage" .
asset_sha256="$(sha256sum "$output/$asset" | cut -d ' ' -f 1)"
RELEASE_VERSION="$version" SOURCE_COMMIT="$source_commit" MIGRATIONS_SHA256="$migrations_sha256" \
  RELEASE_ASSET="$asset" ASSET_SHA256="$asset_sha256" MANIFEST_PATH="$output/linux-release.json" \
  node - <<'NODE'
const fs = require('node:fs');
const env = process.env;
fs.writeFileSync(env.MANIFEST_PATH, JSON.stringify({
  version: env.RELEASE_VERSION,
  sourceCommit: env.SOURCE_COMMIT,
  migrationsSha256: env.MIGRATIONS_SHA256,
  asset: env.RELEASE_ASSET,
  sha256: env.ASSET_SHA256,
}, null, 2) + '\n');
NODE
printf '%s  %s\n' "$asset_sha256" "$asset" > "$output/SHA256SUMS.txt"
printf 'Built %s from %s\nSHA256 %s\n' "$version" "$source_commit" "$asset_sha256"
