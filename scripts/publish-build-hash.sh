#!/usr/bin/env bash
# Writes build-hash.txt as "<commit> <sha256-of-bundle>" (ruling R2, spec §10.2).
#
# Why this file exists at all: a bundle cannot contain the SHA-256 of itself, so the integrity
# display in Settings MEASURES the running bundle at runtime and compares it against this
# published value. That comparison is only meaningful if this value is produced by CI from the
# same commit the bundle was built from -- which is the one thing a compromised host cannot
# forge, because it does not control this repository.
#
# The hash covers the JS bundle specifically, not every asset: it is the JavaScript that does
# the decryption and therefore the only artifact whose substitution matters for the threat spec
# §10 names.
set -euo pipefail

cd "$(dirname "$0")/.."

commit="${1:-$(git rev-parse HEAD)}"

bundle="$(find dist/assets -name 'index-*.js' -type f | head -n 1)"
if [[ -z "$bundle" ]]; then
  echo "publish-build-hash.sh: no dist/assets/index-*.js found -- run the build first" >&2
  exit 1
fi

# Exactly one, or the "the running bundle" the Settings panel hashes is ambiguous and the
# comparison is meaningless.
count="$(find dist/assets -name 'index-*.js' -type f | wc -l)"
if [[ "$count" -ne 1 ]]; then
  echo "publish-build-hash.sh: expected exactly one index-*.js bundle, found $count" >&2
  exit 1
fi

sha="$(sha256sum "$bundle" | cut -d' ' -f1)"
printf '%s %s\n' "$commit" "$sha" > build-hash.txt
echo "build-hash.txt: $commit $sha  ($bundle)"
