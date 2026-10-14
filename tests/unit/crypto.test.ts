import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { armor } from "age-encryption"
import { SCRYPT_LOG_N } from "../../src/config"
import { encryptVault, decryptVault, WrongPassphraseError } from "../../src/vault/crypto"

// Decodes the armor, then returns the header text up to (but not including)
// the "--- <mac>" line -- the part that holds the recipient stanzas, e.g.
// "-> scrypt <salt> <logN>". Everything after the MAC line is binary STREAM
// ciphertext and is not valid UTF-8 in general, so it is deliberately excluded.
function headerOf(armored: string): string {
  const raw = armor.decode(armored)
  const text = new TextDecoder().decode(raw)
  const macIdx = text.indexOf("\n---")
  return macIdx === -1 ? text : text.slice(0, macIdx)
}

async function readFixture(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../fixtures", name), "utf8")
}

test("vault round-trips, armored", async () => {
  const a = await encryptVault("# notes\nline two\n", "a-sufficiently-long-passphrase")
  expect(a).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/)
  expect(await decryptVault(a, "a-sufficiently-long-passphrase")).toBe("# notes\nline two\n")
})

test("writes at the configured work factor", async () => {
  const a = await encryptVault("x", "a-sufficiently-long-passphrase")
  // armor body decodes to a header whose scrypt stanza ends in the work factor
  expect(headerOf(a)).toMatch(new RegExp(`scrypt \\S+ ${SCRYPT_LOG_N}\\b`))
})

// spec §11 — proves the header's factor is honoured, not assumed. The
// original plan called for two age-CLI fixtures at chosen work factors
// (logN=17 and logN=18), but age v1.3.2 has no work-factor flag at all: it
// auto-selects by timing the host machine, so a fixture's factor can be
// observed but never chosen. Two fixtures give equivalent, honest coverage
// instead (ruling R1 in progress.md): `cli-auto.age` is real
// cross-implementation interop, written by the real `age` CLI at whatever
// factor it picked on the machine that generated it (recorded in
// CLI_FACTOR, checked below); `typage-logn18.age` is written by this same
// library at logN=18 -- deliberately different from this project's
// SCRYPT_LOG_N (17) -- which is deterministic, machine-independent proof
// that decryptVault honours the header's declared factor.
test("decrypts files written by the real age CLI, and by this library, at a work factor deliberately different from ours", async () => {
  const pass = (await readFixture("PASSPHRASE")).trim()
  const cliAuto = await readFixture("cli-auto.age")
  const recordedFactor = (await readFixture("CLI_FACTOR")).trim()

  // The recorded factor must actually be what's in the fixture's own header
  // -- otherwise CLI_FACTOR could silently go stale relative to a
  // regenerated cli-auto.age.
  expect(headerOf(cliAuto)).toMatch(new RegExp(`scrypt \\S+ ${recordedFactor}\\b`))

  expect(
    Number(recordedFactor),
    `cli-auto.age was generated at logN=${recordedFactor}, the same as this project's SCRYPT_LOG_N ` +
      `(${SCRYPT_LOG_N}) — it no longer proves a differing work factor is honoured. Regenerate the fixture ` +
      `(bash scripts/make-fixtures.sh), ideally on a machine/moment where the age CLI picks a different ` +
      `factor, and commit the updated cli-auto.age/CLI_FACTOR.`,
  ).not.toBe(SCRYPT_LOG_N)

  expect(await decryptVault(cliAuto, pass)).toBe("interop\n")
  expect(await decryptVault(await readFixture("typage-logn18.age"), pass)).toBe("interop\n")
})

test("a wrong passphrase raises WrongPassphraseError, not a generic failure", async () => {
  const a = await encryptVault("secret", "a-sufficiently-long-passphrase")
  await expect(decryptVault(a, "a-different-long-passphrase")).rejects.toThrow(WrongPassphraseError)
})

test("a Unicode passphrase round-trips and is NOT normalised", async () => {
  // spec §5.5. Verified live against the real CLI with this exact passphrase.
  const p = "schlüsselwort-für-mein-eigenheim-日本語-🔐"
  expect(await decryptVault(await encryptVault("ok\n", p), p)).toBe("ok\n")
  // NFC and NFD are different passphrases, by design — normalising on write
  // would open the vault here but fail under `age -d`.
  const nfd = p.normalize("NFD")
  expect(nfd).not.toBe(p)
  await expect(decryptVault(await encryptVault("ok\n", p), nfd)).rejects.toThrow(WrongPassphraseError)
})

test("text containing age armor delimiters survives a round trip", async () => {
  const nasty = "-----BEGIN AGE ENCRYPTED FILE-----\nnot really\n-----END AGE ENCRYPTED FILE-----\n"
  expect(await decryptVault(await encryptVault(nasty, "a-sufficiently-long-passphrase"), "a-sufficiently-long-passphrase")).toBe(nasty)
})
