import "fake-indexeddb/auto"
import { Decrypter } from "age-encryption"
import { runUnlock, progressMessage, failureMessage, type UnlockOutcome } from "../../src/ui/unlock"
import type { Stage } from "../../src/session/unlock"
import { LocalStore } from "../../src/store/local"
import { GithubStore } from "../../src/store/github"
import { TokenError, RepoPublicError } from "../../src/store/errors"
import { encryptVault, encryptToRecipient } from "../../src/vault/crypto"
import { generateDeviceIdentity, wrapIdentity } from "../../src/vault/identity"

// Ruling R28: the unlock view's real work -- classify what the user typed, run `unlock`, and
// turn every outcome into something showable -- lives in DOM-free functions here rather than
// inside a click handler, so these cases are unit tests instead of 10s Playwright runs. This
// file is named for the VIEW (src/ui/unlock.ts); tests/unit/unlock.test.ts covers the session
// layer (src/session/unlock.ts) it calls.

const PASS = "a-sufficiently-long-unlock-view-passphrase"
const OWNER = "o"
const REPO = "r"

beforeEach(async () => {
  await new LocalStore().clear()
})

function ioWith(local: LocalStore, fetchImpl?: typeof fetch): { local: LocalStore; makeStore: (t: string) => GithubStore } {
  return {
    local,
    makeStore: (token: string) =>
      new GithubStore({
        owner: OWNER,
        repo: REPO,
        token,
        fetch:
          fetchImpl ??
          ((() => {
            throw new Error("this test's unlock must not reach the network")
          }) as unknown as typeof fetch),
      }),
  }
}

/** Seeds a device that has already completed setup: a passphrase-wrapped identity, a token
 * encrypted to it, and a cached vault ciphertext -- i.e. exactly the state src/main.ts routes to
 * the unlock view. */
async function seedUnlockableDevice(local: LocalStore, text: string): Promise<void> {
  const { identity, recipient } = await generateDeviceIdentity()
  await local.putWrappedIdentity(await wrapIdentity(identity, PASS))
  await local.putToken(await encryptToRecipient("gh-token", recipient))
  await local.putCachedVault({ armored: await encryptVault(text, PASS), sha: "sha-v0" })
}

test("an empty passphrase is refused without running any scrypt at all", async () => {
  // A click on Unlock with an empty field must not cost 0.4-2s of KDF to tell the user to type
  // something (spec §5.4's timings are the whole reason this is worth checking).
  const local = new LocalStore()
  await seedUnlockableDevice(local, "never read\n")

  let decrypts = 0
  const restore = instrumentDecrypt(() => {
    decrypts++
  })
  try {
    expect(await runUnlock("   \n", ioWith(local))).toEqual({ kind: "empty" })
  } finally {
    restore()
  }
  expect(decrypts).toBe(0)
})

test("the right passphrase returns the session and reports its stages in order", async () => {
  const local = new LocalStore()
  await seedUnlockableDevice(local, "hello vault\n")

  const stages: Stage[] = []
  const outcome = await runUnlock(PASS, ioWith(local), (s) => stages.push(s))

  expect(outcome.kind).toBe("unlocked")
  if (outcome.kind !== "unlocked") throw new Error("unreachable: asserted above")
  expect(outcome.session.text).toBe("hello vault\n")
  expect(outcome.session.token).toBe("gh-token")
  expect(stages).toEqual(["vault", "token"])
})

test("a wrong passphrase is its own outcome, not a generic failure", async () => {
  const local = new LocalStore()
  await seedUnlockableDevice(local, "hello vault\n")

  expect(await runUnlock("a-wrong-but-long-enough-passphrase", ioWith(local))).toEqual({ kind: "wrong-passphrase" })
})

test("a device with no token stored fails with the error, never a blank outcome", async () => {
  // The first-unlock branch of src/session/unlock.ts needs the token to fetch at all; a device
  // stranded without one (a mid-setup failure) must still get a message.
  const local = new LocalStore()
  const { identity } = await generateDeviceIdentity()
  await local.putWrappedIdentity(await wrapIdentity(identity, PASS))

  const outcome = await runUnlock(PASS, ioWith(local))
  expect(outcome.kind).toBe("failed")
  if (outcome.kind !== "failed") throw new Error("unreachable: asserted above")
  expect(outcome.err).toBeInstanceOf(TokenError)
})

test("every non-success outcome produces a non-empty message", async () => {
  const outcomes: UnlockOutcome[] = [
    { kind: "empty" },
    { kind: "wrong-passphrase" },
    { kind: "failed", err: new TokenError("no GitHub token stored locally") },
    { kind: "failed", err: new RepoPublicError("this repository is public") },
    { kind: "failed", err: new Error("something else entirely") },
    { kind: "failed", err: "a thrown non-Error" },
  ]
  for (const outcome of outcomes) {
    expect(failureMessage(outcome).trim().length).toBeGreaterThan(0)
  }
})

test("the wrong-passphrase message says to try again, since the field is still there", async () => {
  // spec §13: every failure shows a way forward where the problem is visible. For this one the
  // way forward is the passphrase field itself, which the view never removes.
  expect(failureMessage({ kind: "wrong-passphrase" })).toMatch(/again/i)
})

test("the no-token message does not reuse the setup wizard's replace-your-token copy", async () => {
  // Ruling R30's durable lesson, applied before it can bite a second time: shared user-facing
  // copy must be true at every call site. src/ui/setup.ts's `errorRecoveryHtml` answers a
  // TokenError with "This token cannot be used as it is ... then enter it again", which is true
  // at a step that HAS a token and a field to paste into. At unlock, a TokenError means there is
  // no token on this device at all and no field to paste one into, so that copy would be a lie
  // with no action behind it.
  const message = failureMessage({ kind: "failed", err: new TokenError("no GitHub token stored locally") })
  expect(message).not.toMatch(/cannot be used as it is/i)
  // It names the escape hatch the user actually has instead (spec §5.5's recovery sheet).
  expect(message).toMatch(/age -d/)
})

test("the progress message names the stage, and says so when this is the device's first unlock", async () => {
  // src/session/unlock.ts emits stages in exactly two orders, pinned by tests/unit/unlock.test.ts
  // ("with a cached vault: decrypts the vault FIRST, token after" asserts ["vault","token"], and
  // "on a device's first unlock: token, then fetch, then vault" asserts ["token","fetch","vault"]
  // -- `grep -n 'expect(stages).toEqual' tests/unit/unlock.test.ts` shows those two and nothing
  // else), which is what makes "the first stage was `token`" a sound test for a first unlock.
  expect(progressMessage(["vault"])).toMatch(/vault/i)
  expect(progressMessage(["vault"])).not.toMatch(/first unlock/i)
  expect(progressMessage(["token"])).toMatch(/device/i)
  expect(progressMessage(["token", "fetch"])).toMatch(/first unlock/i)
  expect(progressMessage(["token", "fetch", "vault"])).toMatch(/first unlock/i)
  // spec §8: the first unlock is "roughly double" and the indicator has to say so.
  expect(progressMessage(["token", "fetch"])).toMatch(/twice as long|roughly double/i)
})

test("the progress message is never empty, including before the first stage arrives", async () => {
  expect(progressMessage([]).trim().length).toBeGreaterThan(0)
})

/** Counts `Decrypter.prototype.decrypt` calls -- the same prototype patch
 * tests/unit/unlock.test.ts's `instrumentScrypt` uses (see it for why the cast is needed), with
 * only a counter instead of a concurrency peak. */
function instrumentDecrypt(onCall: () => void): () => void {
  const proto = Decrypter.prototype as unknown as { decrypt: (...args: unknown[]) => Promise<unknown> }
  const original = proto.decrypt
  proto.decrypt = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    onCall()
    return original.apply(this, args)
  }
  return () => {
    proto.decrypt = original
  }
}
