// Vault encryption: the one place this project wraps `age-encryption`
// (typage) — pure JS, no WASM (spec §5.1). This file has no Node types
// available (tsconfig.app.json covers `src/`) and must stay that way:
// TextEncoder/TextDecoder/Uint8Array only, which is exactly what
// age-encryption itself needs, nothing more.
//
// Two encryption modes, matching spec §5.1's table:
//   - encryptVault/decryptVault        — passphrase (scrypt): `vault.age`, `device.age`
//   - encryptToRecipient/decryptWithIdentity — X25519, no KDF: `draft.age`, `token.age`
// `vault.age` itself must only ever have the one passphrase recipient
// (never a second one — that would be a second door into the vault), which
// is exactly what encryptVault produces: setPassphrase() and addRecipient()
// are mutually exclusive in age-encryption, so this is enforced by the
// library, not just by convention here.

import { Encrypter, Decrypter, armor } from "age-encryption"
import { SCRYPT_LOG_N } from "../config"

/** Thrown by {@link decryptVault} when the supplied passphrase does not open
 * the vault — as opposed to the armored input being malformed, which
 * rethrows the underlying error unchanged (see decryptVault below). */
export class WrongPassphraseError extends Error {
  constructor(message = "wrong passphrase", options?: ErrorOptions) {
    super(message, options)
    this.name = "WrongPassphraseError"
  }
}

/** Encrypts `plaintext` to a passphrase-only age file, ASCII-armored so the
 * result is copy-pasteable straight into `age -d` (spec §5.2). Always
 * written at this project's {@link SCRYPT_LOG_N}, never age's own CLI
 * default of 18 (spec §5.4). */
export async function encryptVault(plaintext: string, passphrase: string): Promise<string> {
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(SCRYPT_LOG_N)
  return armor.encode(await e.encrypt(plaintext))
}

/** Decrypts an armored, passphrase-encrypted age file. The work factor is
 * read from the file's own header, never assumed to be {@link SCRYPT_LOG_N}
 * — confirmed by the CLI-interop fixtures in crypto.test.ts, one of which is
 * written at a deliberately different factor. */
export async function decryptVault(armored: string, passphrase: string): Promise<string> {
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  try {
    return await d.decrypt(armor.decode(armored), "text")
  } catch (err) {
    // age-encryption throws a plain Error both when no stanza matched this
    // passphrase (wrong passphrase) and when the input is genuinely
    // malformed (bad header, corrupted MAC, ...) — only the former should
    // become WrongPassphraseError. Everything else rethrows unchanged, so a
    // corrupted vault is never misreported as "just retype your passphrase".
    //
    // The substring below is a known coupling to age-encryption's internal
    // error text, not its public API — verified against the exact pinned
    // version (package.json has no `^`, deliberately: a transitive patch
    // bump must not silently change this string under us). Confirmed by
    // reading node_modules/age-encryption@0.3.1/dist/index.js directly:
    // decryptHeaderInternal throws exactly `Error("no identity matched any
    // of the file's recipients")` and nowhere else. Bumping the pin means
    // re-reading that source and re-verifying this substring before trusting
    // the test that covers it.
    if (err instanceof Error && err.message.includes("no identity matched")) {
      throw new WrongPassphraseError(undefined, { cause: err })
    }
    throw err
  }
}

/** Encrypts `plaintext` to a single X25519 recipient (an age public key,
 * `age1...`) — no passphrase, no scrypt. Used for `draft.age`/`token.age`,
 * which are protected by the device identity instead of the vault
 * passphrase (spec §5.1), so per-keystroke autosave never pays for a KDF. */
export async function encryptToRecipient(plaintext: string, recipient: string): Promise<string> {
  const e = new Encrypter()
  e.addRecipient(recipient)
  return armor.encode(await e.encrypt(plaintext))
}

/** Decrypts a file produced by {@link encryptToRecipient} using the matching
 * X25519 identity (`AGE-SECRET-KEY-1...`). */
export async function decryptWithIdentity(armored: string, identity: string): Promise<string> {
  const d = new Decrypter()
  d.addIdentity(identity)
  return await d.decrypt(armor.decode(armored), "text")
}
