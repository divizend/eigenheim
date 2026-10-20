#!/usr/bin/env bash
# The acceptance run (spec §14) against a REAL private GitHub repo, a REAL browser and the REAL
# age binary. Creates the repo, runs the suite, and deletes the repo whatever happens.
#
#   EIGENHEIM_IT_TOKEN=<pat> EIGENHEIM_AGE_BIN=<path-to-age> ./scripts/acceptance.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${EIGENHEIM_IT_TOKEN:?required}"
: "${EIGENHEIM_AGE_BIN:?required -- §14.6 is the point of this run}"

api() {
  local method="$1" path="$2"
  shift 2
  curl -fsS -X "$method" \
    -H "authorization: Bearer $EIGENHEIM_IT_TOKEN" \
    -H "accept: application/vnd.github+json" \
    -H "x-github-api-version: 2022-11-28" \
    "https://api.github.com$path" "$@"
}

OWNER="$(api GET /user | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')"
REPO="eigenheim-acceptance-$(date +%s)"

cleanup() {
  echo "==> deleting $OWNER/$REPO"
  curl -fsS -o /dev/null -X DELETE \
    -H "authorization: Bearer $EIGENHEIM_IT_TOKEN" \
    -H "accept: application/vnd.github+json" \
    "https://api.github.com/repos/$OWNER/$REPO" || echo "WARNING: delete $OWNER/$REPO by hand" >&2
}
trap cleanup EXIT

# `auto_init: true`, not GitHub's default, and not a convenience: a repository with NO commits
# at all has no initialised git database, so `POST /git/blobs` answers 409 Conflict and the
# orphan-branch creation cannot even start. Confirmed live here, and it is the same reason
# tests/integration/github.test.ts sets it. It also matches reality -- a repo created by the
# Deploy button is a clone of the template and always has content on `main`.
echo "==> creating private repo $OWNER/$REPO"
api POST /user/repos -H "content-type: application/json" \
  -d "{\"name\":\"$REPO\",\"private\":true,\"auto_init\":true}" > /dev/null

EIGENHEIM_ACCEPTANCE_OWNER="$OWNER" \
EIGENHEIM_ACCEPTANCE_REPO="$REPO" \
  npx playwright test --config playwright.acceptance.config.ts
