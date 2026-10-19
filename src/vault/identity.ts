// Device identity: a per-device X25519 keypair used to encrypt draft and token
// files, with the private key wrapped under the passphrase for storage (spec §5.1).
//
// Per-keystroke autosave cannot afford a ~400ms scrypt run each time, so the
// identity stays unwrapped in memory while the app is open, and only the
// passphrase-wrapped form goes to storage. This file has no Node types and
// must stay that way (tsconfig.app.json covers `src/`).

import { generateIdentity, identityToRecipient } from "age-encryption"
import { encryptVault, decryptVault } from "./crypto"

/** Generates a fresh X25519 identity and its corresponding recipient (public key). */
export async function generateDeviceIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateIdentity()
  const recipient = await identityToRecipient(identity)
  return { identity, recipient }
}

/** Derives the recipient (public key) of an identity this session already holds unwrapped --
 * what {@link encryptToRecipient} needs to write `draft.age`/`token.age`. {@link Session}
 * (src/session/unlock.ts) carries only the private identity, because that is the half every
 * *read* needs; the editor's autosave is the first writer that needs the public half back
 * (src/ui/editor.ts). Exists so `age-encryption` stays imported by src/vault/ alone -- `grep -rln
 * 'from "age-encryption"' src/` reports exactly src/vault/crypto.ts and src/vault/identity.ts. */
export async function recipientFor(identity: string): Promise<string> {
  return identityToRecipient(identity)
}

/** Wraps an X25519 identity under a passphrase using the same encryption as
 * {@link encryptVault}, so the wrapped form (`device.age`) is protected to the
 * same standard as the vault itself (spec §5.3). */
export async function wrapIdentity(identity: string, passphrase: string): Promise<string> {
  return encryptVault(identity, passphrase)
}

/** Unwraps a passphrase-wrapped identity (the inverse of {@link wrapIdentity}). */
export async function unwrapIdentity(wrapped: string, passphrase: string): Promise<string> {
  return decryptVault(wrapped, passphrase)
}
