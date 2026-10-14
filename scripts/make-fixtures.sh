#!/usr/bin/env bash
# Regenerates the cross-implementation interop fixtures crypto.test.ts reads:
#
#   tests/fixtures/PASSPHRASE        — the passphrase used for both fixtures below
#   tests/fixtures/cli-auto.age      — "interop\n" encrypted by the real age CLI
#   tests/fixtures/CLI_FACTOR        — the scrypt work factor the CLI picked (just the number)
#   tests/fixtures/typage-logn18.age — "interop\n" encrypted by age-encryption itself at logN=18
#
# These are committed, not generated in CI or at test time — unit tests must
# not need network (spec §11).
#
# Why two fixtures, and why "cli-auto"/"typage-logn18" rather than the
# "cli-logn17"/"cli-logn18" names an earlier draft of the plan used: the
# plan's original Step 2 called for the real `age` CLI to write fixtures at
# two *chosen* work factors. That is impossible for age v1.3.2 — `age --help`
# lists no work-factor flag at all (-e -d -o -a -p -r -R -i --version only);
# the Go implementation auto-selects scrypt's logN by timing the host
# machine. So:
#   - cli-auto.age is real cross-implementation interop: the actual age
#     binary, at whatever factor it decides on whatever machine runs this
#     script. The factor it picked is recorded in CLI_FACTOR, and
#     crypto.test.ts asserts that factor differs from this project's
#     SCRYPT_LOG_N (17) — if some future machine's CLI happens to pick 17,
#     that test fails loudly with instructions to regenerate here.
#   - typage-logn18.age gives the other, deterministic half of spec §11's
#     claim ("a differing work factor is honoured, not assumed"): it is
#     written by age-encryption itself at logN=18, deliberately different
#     from SCRYPT_LOG_N, independent of any one machine's timing.
#
# Requires network (downloads the pinned official age release binary) and
# Node (this repo's own age-encryption dependency writes the second
# fixture, and parses the first fixture's header). Run manually whenever
# fixtures need regenerating.

set -euo pipefail

AGE_VERSION="1.3.2"
PLAINTEXT_BODY="interop"
PASSPHRASE_VALUE="eigenheim-interop-fixture-passphrase-do-not-reuse"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures_dir="$repo_root/tests/fixtures"
mkdir -p "$fixtures_dir"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

# --- 1. Fetch the pinned official age binary for this platform -------------
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64) arch="amd64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *)
    echo "make-fixtures.sh: unsupported CPU architecture '$arch'" >&2
    exit 1
    ;;
esac
case "$os" in
  linux | darwin) ;;
  *)
    echo "make-fixtures.sh: unsupported OS '$os' (age v$AGE_VERSION publishes linux/darwin/freebsd/windows release tarballs)" >&2
    exit 1
    ;;
esac

# SHA-256 of each release tarball age v1.3.2 actually publishes, for the
# platforms this script supports (linux/darwin x amd64/arm64). The age
# release itself ships no plain checksums file to check these against —
# each asset instead has a sigsum transparency-log `.proof` file, and fully
# verifying that is a separate, much more involved mechanism (a signed,
# logged inclusion proof, not a hash this script can just compare) that
# this script does not attempt. So this hash *is* the trust anchor, not a
# formality on top of one: it was derived by downloading
# https://github.com/FiloSottile/age/releases/download/v1.3.2/<name>
# directly and hashing it (verified 2026-10-14; the same download this
# script performs below, repeated once under direct observation). Bumping
# AGE_VERSION means re-deriving and re-verifying every value here the same
# way — never copying a hash in from somewhere else unverified.
age_sha256_for() {
  case "$1" in
    linux-amd64) echo "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10" ;;
    linux-arm64) echo "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4" ;;
    darwin-amd64) echo "1d1e4bc66e1427edad7739ae7616157de0e79db8b6d2a1497d7d9925fb06a539" ;;
    darwin-arm64) echo "e2020b073c44f692685a24d6abc378817eb81ffaaf49fd0531ef8565f767f2f5" ;;
    *) echo "" ;;
  esac
}

tarball="age-v${AGE_VERSION}-${os}-${arch}.tar.gz"
url="https://github.com/FiloSottile/age/releases/download/v${AGE_VERSION}/${tarball}"
echo "make-fixtures.sh: downloading $url" >&2
curl -fsSL "$url" -o "$work_dir/$tarball"

expected_sha256="$(age_sha256_for "${os}-${arch}")"
if [[ -z "$expected_sha256" ]]; then
  echo "make-fixtures.sh: no pinned SHA-256 for ${os}-${arch} -- add one (freshly derived from the real release, never copied from elsewhere) before trusting this download" >&2
  exit 1
fi
if [[ "$os" == "darwin" ]]; then
  actual_sha256="$(shasum -a 256 "$work_dir/$tarball" | awk '{print $1}')"
else
  actual_sha256="$(sha256sum "$work_dir/$tarball" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "make-fixtures.sh: SHA-256 mismatch for $tarball -- refusing to run it" >&2
  echo "  expected: $expected_sha256" >&2
  echo "  actual:   $actual_sha256" >&2
  exit 1
fi
echo "make-fixtures.sh: SHA-256 verified for $tarball" >&2

tar -xzf "$work_dir/$tarball" -C "$work_dir"
age_bin="$work_dir/age/age"

observed_version="$("$age_bin" --version)"
if [[ "$observed_version" != "v$AGE_VERSION" ]]; then
  echo "make-fixtures.sh: expected age --version 'v$AGE_VERSION', got '$observed_version'" >&2
  exit 1
fi

# --- 2. Shared plaintext and passphrase fixtures ----------------------------
printf '%s\n' "$PLAINTEXT_BODY" >"$work_dir/plaintext.txt"
printf '%s\n' "$PASSPHRASE_VALUE" >"$fixtures_dir/PASSPHRASE"

# --- 3. cli-auto.age: drive the real, interactive `age -p -a` through a pty -
# age reads the passphrase from /dev/tty, not stdin, so a plain pipe does not
# work (confirmed live) — this spawns age under a real pty and answers both
# the "Enter passphrase" and "Confirm passphrase" prompts.
echo "make-fixtures.sh: running age -p -a (pty-automated)" >&2
AGE_PASSPHRASE="$PASSPHRASE_VALUE" python3 - "$age_bin" -p -a -o "$fixtures_dir/cli-auto.age" "$work_dir/plaintext.txt" <<'PYEOF'
import os
import select
import sys
import time
import pty

passphrase = (os.environ["AGE_PASSPHRASE"] + "\n").encode()
age_bin, *args = sys.argv[1:]

pid, fd = pty.fork()
if pid == 0:
    os.execv(age_bin, [age_bin, *args])
    os._exit(127)  # pragma: no cover - only reached if execv fails

buf = b""
sent_enter = sent_confirm = False
deadline = time.time() + 30
while True:
    if time.time() > deadline:
        os.kill(pid, 9)
        sys.exit("make-fixtures.sh: timed out waiting for age's passphrase prompt")
    ready, _, _ = select.select([fd], [], [], 1)
    if fd in ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            break
        buf += chunk
        if b"Enter passphrase" in buf and not sent_enter:
            os.write(fd, passphrase)
            sent_enter, buf = True, b""
        elif b"Confirm passphrase" in buf and not sent_confirm:
            os.write(fd, passphrase)
            sent_confirm, buf = True, b""
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid != 0:
        sys.exit(os.WEXITSTATUS(status))

# The loop above can also end via `break` on EOF (the pty closed) without
# WNOHANG having observed the exit yet. Block for the real exit status there
# too, rather than falling off the end with an untested implicit 0 — a
# genuine age failure must fail this script, not look like success.
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status))
PYEOF

# --- 4. Record the factor age actually picked -------------------------------
# Parsed with this project's own age-encryption package (not a hand-rolled
# regex over the armor text), so CLI_FACTOR means exactly what decryptVault
# will see.
(cd "$repo_root" && node --input-type=module - "$fixtures_dir/cli-auto.age" "$fixtures_dir/CLI_FACTOR" <<'NODEEOF'
import { readFileSync, writeFileSync } from "node:fs"
import { armor } from "age-encryption"

const [, , armoredPath, outPath] = process.argv
const armored = readFileSync(armoredPath, "utf8")
const header = new TextDecoder().decode(armor.decode(armored))
const match = header.match(/^-> scrypt \S+ (\d+)$/m)
if (!match) throw new Error(`no scrypt stanza found in ${armoredPath}'s header`)
writeFileSync(outPath, match[1] + "\n")
console.error(`make-fixtures.sh: age CLI picked logN=${match[1]}`)
NODEEOF
)

# --- 5. typage-logn18.age: written by age-encryption itself, not the CLI ----
# logN=18 is deliberately different from this project's SCRYPT_LOG_N (17) —
# see crypto.test.ts for why that difference is the point.
(cd "$repo_root" && node --input-type=module - "$work_dir/plaintext.txt" "$fixtures_dir/PASSPHRASE" "$fixtures_dir/typage-logn18.age" <<'NODEEOF'
import { readFileSync, writeFileSync } from "node:fs"
import { Encrypter, armor } from "age-encryption"

const [, , plaintextPath, passphrasePath, outPath] = process.argv
const plaintext = readFileSync(plaintextPath, "utf8")
const passphrase = readFileSync(passphrasePath, "utf8").trim()

const e = new Encrypter()
e.setPassphrase(passphrase)
e.setScryptWorkFactor(18)
const raw = await e.encrypt(plaintext)
writeFileSync(outPath, armor.encode(raw))
NODEEOF
)

echo "make-fixtures.sh: wrote $(ls "$fixtures_dir" | tr '\n' ' ')" >&2
