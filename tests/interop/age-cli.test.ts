import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encryptVault } from "../../src/vault/crypto"

// OUTBOUND interop: a vault written by THIS app, read by the REAL age binary.
//
// This is the test defending spec §1's central promise -- that the vault is an ordinary age file
// its owner can always open without this app, with nothing but their passphrase. No unit test
// can establish it: typage decrypting its own output proves the two halves of one library agree
// with each other, not that the FORMAT is right. Only the real implementation can say that.
//
// The INBOUND direction is covered separately and already, in tests/unit/crypto.test.ts against
// tests/fixtures/cli-auto.age, which the real `age -p` produced.
//
// Skips, loudly and with a reason, when the binary is absent -- the same discipline the
// integration suite uses for its token. CI always provides it, so CI never skips.

const AGE_BIN = process.env.EIGENHEIM_AGE_BIN ?? ""
const PASSPHRASE = "interop-check-passphrase-with-ünïcödé-and-emoji-🔐"
const PLAINTEXT = "first line\nsecond line with ünïcödé and 日本語\nthird line\n"

const describeOrSkip = AGE_BIN ? describe : describe.skip
if (!AGE_BIN) {
  // eslint-disable-next-line no-console
  console.warn("tests/interop/age-cli.test.ts: SKIPPED — set EIGENHEIM_AGE_BIN to the real age binary to run it.")
}

describeOrSkip("the real age binary reads this app's vault", () => {
  let work: string
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "eigenheim-interop-"))
  })
  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
  })

  test("the pinned age binary is the version this project claims to interoperate with", () => {
    const version = execFileSync(AGE_BIN, ["--version"], { encoding: "utf-8" }).trim()
    expect(version).toBe("v1.3.2")
  })

  test("age -d recovers byte-for-byte what encryptVault wrote, including non-ASCII", async () => {
    const vault = join(work, "vault.age")
    const out = join(work, "decrypted.txt")
    writeFileSync(vault, await encryptVault(PLAINTEXT, PASSPHRASE))

    // Driven through a pty: age reads passphrases from /dev/tty, never stdin (confirmed live --
    // a plain pipe fails with "standard input is not a terminal").
    execFileSync("python3", ["scripts/age-pty.py", AGE_BIN, "-d", "-o", out, vault], {
      env: { ...process.env, AGE_PASSPHRASE: PASSPHRASE },
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Byte-for-byte, read as a Buffer rather than a string: a comparison via UTF-8 decoding
    // could hide a real difference by normalising it away, and this test exists precisely to
    // catch differences.
    expect(readFileSync(out)).toEqual(Buffer.from(PLAINTEXT, "utf-8"))
  })

  test("the armored output is the copy-pasteable PEM form the recovery sheet promises", async () => {
    // Spec §5.2: the recovery sheet tells the user to run `age -d vault.age`. That only works if
    // what is committed is ASCII-armored, which is also what makes the file survive being
    // emailed, pasted or stored as text anywhere.
    const armored = await encryptVault(PLAINTEXT, PASSPHRASE)
    expect(armored.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true)
    expect(armored.trimEnd().endsWith("-----END AGE ENCRYPTED FILE-----")).toBe(true)
  })

  test("a wrong passphrase makes the real age fail, so the test above cannot pass vacuously", async () => {
    const vault = join(work, "vault2.age")
    writeFileSync(vault, await encryptVault(PLAINTEXT, PASSPHRASE))

    expect(() =>
      execFileSync("python3", ["scripts/age-pty.py", AGE_BIN, "-d", "-o", join(work, "nope.txt"), vault], {
        env: { ...process.env, AGE_PASSPHRASE: "the-wrong-passphrase-entirely" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow()
  })
})
