import {
  generateDeviceIdentity,
  wrapIdentity,
  unwrapIdentity,
} from "../../src/vault/identity"
import { encryptToRecipient, decryptWithIdentity } from "../../src/vault/crypto"

test("a generated identity wraps under the passphrase and unwraps back", async () => {
  const { identity } = await generateDeviceIdentity()
  const w = await wrapIdentity(identity, "a-sufficiently-long-passphrase")
  expect(await unwrapIdentity(w, "a-sufficiently-long-passphrase")).toBe(identity)
})

test("identities are distinct per device", async () => {
  expect((await generateDeviceIdentity()).identity).not.toBe(
    (await generateDeviceIdentity()).identity,
  )
})

test("the wrapped identity is an age file, not plaintext", async () => {
  const { identity } = await generateDeviceIdentity()
  const w = await wrapIdentity(identity, "a-sufficiently-long-passphrase")
  expect(w).not.toContain(identity)
  expect(w).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/)
})

test("content encrypted to the device recipient opens with its identity", async () => {
  const { identity, recipient } = await generateDeviceIdentity()
  expect(
    await decryptWithIdentity(
      await encryptToRecipient("draft text", recipient),
      identity,
    ),
  ).toBe("draft text")
})
