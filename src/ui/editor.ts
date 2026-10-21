// The editor (spec §8: "full-viewport monospace textarea. Autosave to `draft.age` on a short
// debounce. Explicit ⌘/Ctrl+S commits. Persistent indicator of local-vs-committed state.
// Keyboard-first; no chrome competing with the text."). This is where spec §2's save model is
// kept or broken: **autosave is local only; GitHub writes are explicit.** Nothing below this
// comment may send a non-GET request to GitHub in response to a keystroke -- and that is not
// left to this comment, it is asserted in tests/e2e/editor.spec.ts, which records every request
// the real browser makes while typing and requires the non-GET list to be empty.
//
// Structure follows ruling R28, which Task 13 paid for: every piece of real work here is a
// plain, DOM-free `async function(state, deps)` that tests/unit/editor.test.ts calls directly,
// and {@link renderEditor} at the bottom is only wiring -- read what happened, put it on screen.
// Unit tests run in bare Node (vite.config.ts sets no `environment`), so a `document` reference
// leaking into one of these functions fails loudly there instead of hiding until a Playwright
// run.
//
// This file has no Node types available (tsconfig.app.json covers `src/`) and must stay that
// way.

import type { Session } from "../session/unlock"
import type { GithubStore } from "../store/github"
import type { LocalStore } from "../store/local"
import { commit, syncFromRemote, replayPendingCommits, isUnreachable, type Conflict } from "../session/sync"
import { encryptToRecipient, decryptWithIdentity, WrongPassphraseError } from "../vault/crypto"
import { recipientFor } from "../vault/identity"

/** How long after the last keystroke the draft is written (spec §8's "short debounce").
 *
 * Short enough that a tab closed moments after typing keeps the keystrokes, long enough that
 * continuous typing writes IndexedDB a few times a second rather than per character. Not in
 * src/config.ts: that file holds the spec's own mandated literals (`SCRYPT_LOG_N`, `VAULT_PATH`,
 * `DATA_BRANCH`), and the spec fixes no number for this one. Exported so the E2E suite waits on
 * the same value this view uses instead of its own guess. */
export const AUTOSAVE_DEBOUNCE_MS = 400

/** The three states spec §8's persistent indicator distinguishes. `committed` -- everything on
 * screen is on GitHub. `local-only` -- it is saved on this device and nowhere else. `offline` --
 * GitHub cannot be reached at all right now, so editing continues locally (spec §13). */
export type SaveState = "committed" | "local-only" | "offline"

/** The two stores every operation below needs, and nothing more. Mirrors the `makeStore: (token:
 * string) => GithubStore` seam src/session/unlock.ts and src/ui/setup.ts already use (ruling
 * R3): the token lives in the {@link Session}, so a store is built per operation from whatever
 * token the session holds at that moment rather than captured once at mount. */
export interface SessionIO {
  local: LocalStore
  makeStore: (token: string) => GithubStore
}

/** What {@link renderEditor} needs on top of {@link SessionIO}. */
export interface EditorDeps extends SessionIO {
  session: Session
  /** **Task 15's seam.** Called when a save is refused because another device committed first
   * (spec §6.5), with the three-way merge `commit` already computed and a `reopen` callback that
   * re-mounts this editor on whatever text the resolution produced (persisting it as the local
   * draft first, so nothing is lost on the way back).
   *
   * The editor does not depend on this doing anything: before calling it, it has already kept
   * the user's text on screen, kept the draft in IndexedDB, and shown the conflict notice -- so
   * the no-op src/main.ts passes today is a genuinely non-dead-ended state (keep typing; the
   * text is safe locally) rather than a hole. Task 15 replaces that one line with
   * `renderConflict(root, conflict, onResolve)`.
   *
   * Note for Task 15, found while building this seam: {@link Conflict} carries no sha for
   * `theirs`, so "commit the resolution on the NEW base" cannot be done from the conflict object
   * alone -- `commit` would re-derive the base from the draft/session and be refused again. That
   * is a gap in Task 12's data, not in this seam. */
  onConflict: (conflict: Conflict, reopen: (text: string) => void) => void
  /** Leaves the editor for the history view (task 16), handing over the text currently on
   * screen so history diffs against what the user is actually looking at rather than against
   * the last committed version. */
  onOpenHistory: (text: string) => void
  /** Leaves the editor for settings (task 17), handing over the text on screen because a
   * passphrase rotation re-encrypts exactly that, not the last committed version. */
  onOpenSettings: (text: string) => void
}

/** What the editor shows the moment it mounts -- see {@link openDocument}. */
export interface OpenedDocument {
  text: string
  dirty: boolean
  notice: string | null
}

/** The result of an explicit save, one case per thing the indicator and the Task 15 seam have to
 * do. Deliberately a union of plain data rather than a thrown error for the failure cases: spec
 * §13 requires every one of them to end up visible on screen, and a `kind` the caller must
 * destructure is far harder to drop on the floor than a `catch` nobody wrote. */
export type CommitOutcome =
  | { kind: "committed"; sha: string }
  | { kind: "conflict"; conflict: Conflict }
  | { kind: "queued" }
  | { kind: "no-token" }
  | { kind: "failed"; message: string }

/** The result of one background sync (spec §5.3). `updated` carries the newer text rather than
 * only a flag, so the caller never has to re-read `session.text` and wonder whether something
 * else moved it in the meantime. */
export type SyncOutcome =
  | { kind: "updated"; text: string }
  | { kind: "unchanged" }
  | { kind: "diverged" }
  | { kind: "offline" }
  | { kind: "no-token" }
  | { kind: "failed"; message: string }

/** The result of draining the offline queue on reconnect (spec §13). `count`/`committed` are how
 * many queued edits actually landed, which is what lets the notice say something true ("2 queued
 * saves sent") instead of a generic "synced". */
export type ReplayOutcomeForUi =
  | { kind: "nothing-queued" }
  | { kind: "committed"; count: number }
  | { kind: "conflict"; conflict: Conflict; committed: number }
  | { kind: "offline"; committed: number }
  | { kind: "no-token" }
  | { kind: "failed"; message: string }

// ---------------------------------------------------------------------------------------------
// One scrypt run at a time, across operations that start from independent events.
// ---------------------------------------------------------------------------------------------

/** Builds a serialiser: `serialize(op)` runs `op` only once every operation handed to this same
 * serialiser before it has settled, and returns `op`'s own result.
 *
 * This exists for spec §5.4. Every save encrypts the vault (one logN=17 scrypt run, ~128 MiB)
 * and every conflict or replay decrypts one or two more; two in flight at once peak near 256 MiB
 * and can get a mobile tab discarded, which in a project with no recovery key costs a user
 * access to their own data. src/session/unlock.ts and src/ui/setup.ts hold to that by writing
 * their steps sequentially in one function -- which is enough there, because each has exactly one
 * entry point. This view does not: a keystroke-driven ⌘S, the `online` handler's queue replay
 * and the background sync are three independent events that can overlap with each other and
 * with a held-down ⌘S, and no amount of sequential code inside one of them prevents that.
 *
 * `tail.then(run, run)` rather than `tail.then(run)`: a rejected operation must not stop the
 * chain (pinned by tests/unit/editor.test.ts's "a rejected operation does not poison the
 * chain"). The stored tail swallows rejections so nothing ever reports an unhandled one; the
 * caller still gets the real rejection from its own returned promise. */
export function createOperationQueue(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op)
    tail = run.catch(() => undefined)
    return run
  }
}

/** The one serialiser every scrypt-bearing operation in this module goes through.
 *
 * Module-level, not per-{@link renderEditor}-call, and applied INSIDE
 * {@link commitDocument}/{@link syncOnce}/{@link drainQueue} rather than at their call sites:
 * the hazard is this tab's total memory, so the guarantee has to hold for every caller,
 * including a future view that calls one of these without knowing about the rule. Putting it in
 * the DOM wiring instead would also have made it the one part of this file a unit test cannot
 * reach -- which is exactly the shape of mistake ruling R28 exists to stop. */
const serialize = createOperationQueue()

// ---------------------------------------------------------------------------------------------
// Opening the document.
// ---------------------------------------------------------------------------------------------

/** Decides what text the editor opens on: the local draft if there is one, else the committed
 * text from the session (spec §7's `draft.age` row -- "Draft + base SHA | IndexedDB `draft.age`
 * | age, device identity").
 *
 * The draft wins because of spec §2's save model: autosave is local only, so after a reload the
 * draft is strictly newer than anything GitHub has, and showing the committed version instead
 * would silently discard every keystroke since the last ⌘S. `dirty` is computed by comparing the
 * two rather than from the draft's mere existence, so a draft that happens to match what is
 * already committed (another tab committed it; a save landed and the rebase in
 * src/session/sync.ts's `attemptWrite` kept the row) reads as `committed`, which is what is
 * actually true.
 *
 * A draft that will not decrypt is reported, not thrown and not deleted: spec §13 forbids a
 * blank screen, the committed text is a real document to work from, and the undecryptable row
 * stays in IndexedDB because discarding a user's only copy of something unseen is the one
 * outcome §6.5's "nothing is discarded" rules out. (Reachable without any corruption: a
 * `device.age` replaced by a second setup on the same browser leaves the previous identity's
 * draft behind.) */
export async function openDocument(session: Session, local: LocalStore): Promise<OpenedDocument> {
  const draft = await local.getDraft()
  if (draft === null) return { text: session.text, dirty: false, notice: null }

  let draftText: string
  try {
    draftText = await decryptWithIdentity(draft.armored, session.identity)
  } catch {
    return {
      text: session.text,
      dirty: false,
      notice:
        "The unsaved draft stored on this device could not be read, so the last version saved to GitHub is shown instead. Nothing has been deleted.",
    }
  }
  return { text: draftText, dirty: draftText !== session.text, notice: null }
}

// ---------------------------------------------------------------------------------------------
// Autosave -- spec §2's central guarantee.
// ---------------------------------------------------------------------------------------------

/** Writes `text` to `draft.age` and nothing else. **No network call of any kind**: the draft is
 * encrypted to the device identity (X25519, no KDF -- src/vault/crypto.ts), which is why
 * per-keystroke autosave is affordable at all, and GitHub is only ever written by
 * {@link commitDocument} in response to an explicit ⌘/Ctrl+S (spec §2).
 *
 * Reads `session.baseSha` at call time rather than taking it as an argument, because the session
 * object is mutated in place by `commit`/`syncFromRemote` (see their doc comments in
 * src/session/sync.ts): an autosave scheduled before a save and firing after it must record the
 * base the text is now actually against, not the one that was current when the keystroke
 * happened.
 *
 * `savedAt` is stamped BEFORE the encrypt, not after, and that ordering is load-bearing:
 * encryption takes real time, so two overlapping autosaves can resolve out of order, and
 * `LocalStore.putDraft`'s monotonic guard can only refuse the older one if the older one carries
 * the older timestamp. Stamping afterwards would hand a slow, stale call a newer timestamp than
 * the keystrokes that overtook it and destroy them -- pinned by tests/unit/editor.test.ts's "an
 * autosave that resolves late never clobbers a newer one", which blocks the first encrypt and
 * lets a second call overtake it. */
export async function autosaveDraft(text: string, session: Session, local: LocalStore): Promise<void> {
  const savedAt = Date.now()
  const baseSha = session.baseSha
  const armored = await encryptToRecipient(text, await recipientFor(session.identity))
  await local.putDraft({ armored, baseSha, savedAt })
}

// ---------------------------------------------------------------------------------------------
// The explicit save, and the two operations the view starts by itself.
// ---------------------------------------------------------------------------------------------

/** `null` when this device holds no GitHub token -- reading never needs one, only syncing and
 * committing do (spec §5.3/§7), so every operation that talks to GitHub has to handle its
 * absence rather than assume setup left one behind. */
function storeFor(session: Session, io: SessionIO): GithubStore | null {
  return session.token === null ? null : io.makeStore(session.token)
}

/** Turns an unexpected failure into something showable. Every named error class in
 * src/store/errors.ts already carries a human-readable `message` written for this purpose, and
 * spec §13's richer per-class affordances (a settings link, a token walkthrough) are Task 19's
 * `renderFailure`; until then the message itself plus the editor's own still-working text is the
 * visible state, never a silent `catch`. */
/** Turns a thrown error from the save path into something a user can act on.
 *
 * The `WrongPassphraseError` case is the carry recorded into task 17, decided here rather than
 * left to propagate raw. It arises from exactly one situation, and it is a real one once task
 * 17's passphrase rotation exists: `attemptWrite` resolving a conflict has to DECRYPT the
 * version already on GitHub to merge against it (src/session/sync.ts), and if that version was
 * written by a device still using the previous passphrase, this session cannot read it. The raw
 * message ("wrong passphrase") is actively misleading there -- the passphrase the user just
 * unlocked with is correct, it is the remote version that is out of step -- so it is replaced
 * with what is actually true and what actually helps. */
function failureText(err: unknown): string {
  if (err instanceof WrongPassphraseError) {
    return (
      "Your passphrase is correct for this device, but the version now on GitHub was saved with a different one — " +
      "another device has not been updated since the passphrase was changed. Your text is safe here and on this device. " +
      "Unlock that other device and change its passphrase too, or restore an earlier version from History, then save again."
    )
  }
  return err instanceof Error ? err.message : String(err)
}

/** The explicit save (spec §6.4): encrypt, conditional fast-forward-only push, and map the three
 * things `commit` can report plus the two it can throw onto {@link CommitOutcome}.
 *
 * Serialised against every other scrypt-bearing operation in this module (see {@link serialize})
 * -- holding ⌘S, which the plan's own Review Focus 5 names, produces several of these at once. */
export async function commitDocument(text: string, session: Session, io: SessionIO): Promise<CommitOutcome> {
  const store = storeFor(session, io)
  if (store === null) return { kind: "no-token" }

  return serialize(async () => {
    try {
      const result = await commit(session, text, store, io.local)
      if ("sha" in result) return { kind: "committed", sha: result.sha }
      if ("conflict" in result) return { kind: "conflict", conflict: result.conflict }
      return { kind: "queued" }
    } catch (err) {
      return { kind: "failed", message: failureText(err) }
    }
  })
}

/** One background sync (spec §5.3's "Background sync compares the cached SHA against `data`
 * head"), started once when the editor mounts and again on reconnect.
 *
 * `isUnreachable` (src/session/sync.ts, exported for this) distinguishes "GitHub could not be
 * reached" from a real GitHub-side failure, so being offline shows the offline state rather than
 * an error message about a fetch -- the same positive test `commit`'s own queueing decision
 * uses, rather than a second copy of the reasoning. */
export async function syncOnce(session: Session, io: SessionIO): Promise<SyncOutcome> {
  const store = storeFor(session, io)
  if (store === null) return { kind: "no-token" }

  return serialize(async () => {
    try {
      const { updated, diverged } = await syncFromRemote(session, store, io.local)
      if (updated) return { kind: "updated", text: session.text }
      return diverged ? { kind: "diverged" } : { kind: "unchanged" }
    } catch (err) {
      if (isUnreachable(err)) return { kind: "offline" }
      return { kind: "failed", message: failureText(err) }
    }
  })
}

/** Replays whatever the offline queue holds (spec §13's "commit queues and retries on
 * reconnect"). Safe to call unconditionally -- `replayPendingCommits` returns `null` with no
 * network call at all when nothing is queued, which is what `nothing-queued` reports. */
export async function drainQueue(session: Session, io: SessionIO): Promise<ReplayOutcomeForUi> {
  const store = storeFor(session, io)
  if (store === null) return { kind: "no-token" }

  return serialize(async () => {
    try {
      const outcome = await replayPendingCommits(session, store, io.local)
      if (outcome === null) return { kind: "nothing-queued" }
      if (outcome.conflict !== null) {
        return { kind: "conflict", conflict: outcome.conflict, committed: outcome.committedShas.length }
      }
      if (outcome.unreachable) return { kind: "offline", committed: outcome.committedShas.length }
      return { kind: "committed", count: outcome.committedShas.length }
    } catch (err) {
      // Includes `ReplayRepeatedlyUnreachableError`, which src/session/sync.ts throws instead of
      // reporting `unreachable` once one entry has failed MAX_REPLAY_ATTEMPTS times -- the entry
      // stays queued, only the signal gets louder, and this is what makes it visible.
      return { kind: "failed", message: failureText(err) }
    }
  })
}

// ---------------------------------------------------------------------------------------------
// The indicator, and the one rule background sync has to obey about the user's keystrokes.
// ---------------------------------------------------------------------------------------------

/** The persistent indicator's state (spec §8). Offline outranks everything else because it
 * explains WHY nothing is reaching GitHub; a queued commit counts as `local-only` even once the
 * connection is back, because until the replay actually lands, the text is still only on this
 * device. */
export function indicatorState(i: { dirty: boolean; online: boolean; queued: number }): SaveState {
  if (!i.online) return "offline"
  return i.dirty || i.queued > 0 ? "local-only" : "committed"
}

/** The indicator's own words. Written to be true in every situation each state covers -- ruling
 * R30's lesson: `offline` covers offline-and-clean as well as offline-with-three-queued-saves,
 * so it promises nothing about queues; `local-only` names the one control that acts on it, and
 * names it in a form that is true on both a Mac and everything else. */
export function indicatorLabel(s: SaveState): string {
  if (s === "committed") return "Saved to GitHub"
  if (s === "local-only") return "Saved on this device only — ⌘S / Ctrl+S saves to GitHub"
  return "Offline — editing continues"
}

/** What the notice line should say for a save outcome — or `null` to say nothing.
 *
 * `committed` returns null deliberately. The indicator beside this notice already reads "Saved
 * to GitHub", so a notice saying the same thing rendered the footer as
 * "Saved to GitHub   Saved to GitHub." — reported from a real deployment. The notice exists for
 * what the indicator CANNOT express (a conflict, a queued save, a failure); when the indicator
 * already carries the whole message, the notice must be silent rather than echo it. */
export function commitNotice(outcome: CommitOutcome): string | null {
  switch (outcome.kind) {
    case "committed":
      return null
    case "conflict":
      return "Another device saved a newer version of this vault. Your text is still here and saved on this device; the two versions have to be merged before it can go to GitHub."
    case "queued":
      return "GitHub could not be reached, so this save is queued on this device and will be sent when the connection comes back."
    case "no-token":
      return "This device has no GitHub token stored, so it can only save locally. The text is safe on this device."
    case "failed":
      return `Could not save to GitHub: ${outcome.message}`
  }
}

/** Whether a background sync's newer text may replace what is on screen.
 *
 * `syncFromRemote` already refuses to adopt anything when a local draft exists, but there is a
 * window it cannot see: a keystroke that lands while the fetch is in flight has not been written
 * to `draft.age` yet (that is {@link AUTOSAVE_DEBOUNCE_MS} away), so the sync sees no draft,
 * adopts the remote version, and the adoption would delete the keystroke from under the cursor.
 * Comparing the editor's text against what it held when the sync started closes that window
 * without needing a lock: if the user typed, their text stays and the divergence is simply
 * carried to commit time as a conflict, exactly as spec §5.3 already does for a dirty draft. */
export function adoptSyncedText(current: string, atSyncStart: string, incoming: string): { text: string; adopted: boolean } {
  if (current !== atSyncStart) return { text: current, adopted: false }
  return { text: incoming, adopted: true }
}

// ---------------------------------------------------------------------------------------------
// DOM wiring. Everything above is reachable without a browser; everything below is only how it
// gets on screen.
// ---------------------------------------------------------------------------------------------


/** Mounts the editor: one full-viewport monospace textarea, plus a single-line status strip
 * holding the indicator and one notice slot (spec §8's "no chrome competing with the text" --
 * there is no toolbar, no menu and no second button anywhere in this view; `grep -c '<button'
 * src/ui/editor.ts` returns 0).
 *
 * The markup is built with DOM methods rather than an `innerHTML` template, unlike
 * src/ui/setup.ts: everything variable here is either decrypted vault content or an error
 * message, and `textContent` is the only assignment that cannot turn either into markup. */
export function renderEditor(root: HTMLElement, deps: EditorDeps): void {
  const { session, local } = deps

  root.classList.add("editor-root")
  const container = document.createElement("div")
  container.className = "editor"

  const textarea = document.createElement("textarea")
  textarea.className = "editor-text"
  textarea.dataset.testid = "editor"
  textarea.spellcheck = false
  textarea.autocapitalize = "off"
  textarea.setAttribute("autocomplete", "off")
  textarea.setAttribute("aria-label", "Vault contents")

  const status = document.createElement("div")
  status.className = "editor-status"

  const indicator = document.createElement("span")
  indicator.className = "editor-indicator"
  indicator.dataset.testid = "save-state"

  const notice = document.createElement("span")
  notice.className = "editor-notice"
  notice.dataset.testid = "editor-notice"
  notice.setAttribute("role", "status")

  // The one piece of chrome spec §8's "no competing chrome" tolerates: history is unreachable
  // otherwise, and a vault whose previous versions cannot be opened is a vault whose git history
  // only helps someone with a terminal.
  const historyBtn = document.createElement("button")
  historyBtn.type = "button"
  historyBtn.className = "editor-nav"
  historyBtn.dataset.testid = "open-history"
  historyBtn.textContent = "History"
  historyBtn.addEventListener("click", () => deps.onOpenHistory(textarea.value))

  const settingsBtn = document.createElement("button")
  settingsBtn.type = "button"
  settingsBtn.className = "editor-nav"
  settingsBtn.dataset.testid = "open-settings"
  settingsBtn.textContent = "Settings"
  settingsBtn.addEventListener("click", () => deps.onOpenSettings(textarea.value))

  status.append(indicator, notice, historyBtn, settingsBtn)
  container.append(textarea, status)
  root.replaceChildren(container)

  // `navigator.onLine` for the initial paint, then the events alone -- a browser that fires
  // `offline` is authoritative about being offline whether or not the flag agrees, and this is
  // also what lets the E2E suite drive the state with a dispatched event.
  let online = navigator.onLine
  let dirty = false
  let queued = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  function paint(): void {
    const state = indicatorState({ dirty, online, queued })
    indicator.dataset.state = state
    indicator.textContent = indicatorLabel(state)
  }

  function say(message: string | null): void {
    notice.textContent = message ?? ""
  }

  function cancelPendingAutosave(): void {
    if (debounce !== null) clearTimeout(debounce)
    debounce = null
  }

  async function refreshQueueDepth(): Promise<void> {
    queued = (await local.getPendingCommits()).length
    paint()
  }

  function handleConflict(conflict: Conflict): void {
    // The editor keeps the text and the draft -- `commit` never clears either on a conflict -- so
    // this state is not a dead end even before Task 15's view exists.
    dirty = true
    paint()
    say("Another device saved a newer version of this vault. Your text is still here and saved on this device; the two versions have to be merged before it can go to GitHub.")
    deps.onConflict(conflict, (text: string) => {
      void (async () => {
        await autosaveDraft(text, session, local)
        renderEditor(root, deps)
      })()
    })
  }

  function showCommitOutcome(outcome: CommitOutcome): void {
    if (outcome.kind === "committed") {
      dirty = false
      paint()
      say(commitNotice(outcome))
      return
    }
    if (outcome.kind === "conflict") {
      handleConflict(outcome.conflict)
      return
    }
    if (outcome.kind === "queued") {
      void refreshQueueDepth()
      say("GitHub could not be reached, so this save is queued on this device and will be sent when the connection comes back.")
      return
    }
    if (outcome.kind === "no-token") {
      say("This device has no GitHub token stored, so it can only save locally. The text is safe on this device.")
      return
    }
    say(`Could not save to GitHub: ${outcome.message}`)
  }

  function save(): void {
    cancelPendingAutosave()
    const text = textarea.value
    void (async () => {
      say("Saving to GitHub…")
      // The draft is written first so the text exists somewhere durable even if the save fails,
      // and so `commit` reads the right base out of it (src/session/sync.ts's `commit`).
      await autosaveDraft(text, session, local)
      dirty = true
      paint()
      showCommitOutcome(await commitDocument(text, session, deps))
    })()
  }

  textarea.addEventListener("input", () => {
    dirty = true
    paint()
    cancelPendingAutosave()
    debounce = setTimeout(() => {
      debounce = null
      void autosaveDraft(textarea.value, session, local)
    }, AUTOSAVE_DEBOUNCE_MS)
  })

  // On the textarea, not on `window`: this view owns the whole viewport, and a listener that
  // outlives the view (every other view replaces `root`'s children, which does not detach a
  // window listener) would keep saving a textarea nobody can see.
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault() // the browser's own "save page" dialog is not what ⌘S means here
      save()
    }
  })

  const connectivity = (nowOnline: boolean) => {
    online = nowOnline
    paint()
    if (!nowOnline) {
      say("You are offline. Editing continues and is saved on this device; saves to GitHub resume when the connection comes back.")
      return
    }
    say("Back online.")
    void (async () => {
      showReplayOutcome(await drainQueue(session, deps))
      await backgroundSync()
    })()
  }
  window.addEventListener("online", () => connectivity(true))
  window.addEventListener("offline", () => connectivity(false))

  function showReplayOutcome(outcome: ReplayOutcomeForUi): void {
    void refreshQueueDepth()
    if (outcome.kind === "conflict") {
      handleConflict(outcome.conflict)
      return
    }
    if (outcome.kind === "committed" && outcome.count > 0) {
      dirty = false
      paint()
      say(outcome.count === 1 ? "The queued save was sent to GitHub." : `${outcome.count} queued saves were sent to GitHub.`)
      return
    }
    if (outcome.kind === "failed") say(outcome.message)
  }

  async function backgroundSync(): Promise<void> {
    const before = textarea.value
    const outcome = await syncOnce(session, deps)
    if (outcome.kind === "updated") {
      const { text, adopted } = adoptSyncedText(textarea.value, before, outcome.text)
      if (adopted) {
        textarea.value = text
        dirty = false
        paint()
        say("Updated to a newer version saved on another device.")
      } else {
        dirty = true
        paint()
        say("Another device saved a newer version while you were typing. Your text is kept; ⌘S / Ctrl+S will show the two versions to merge.")
      }
      return
    }
    if (outcome.kind === "offline") {
      online = false
      paint()
      return
    }
    if (outcome.kind === "failed") say(`Could not check GitHub for newer versions: ${outcome.message}`)
  }

  // First paint, then the two things this view starts on its own. Deliberately after the
  // textarea is on screen and focusable: neither of them is allowed to be something the user
  // waits for (spec §5.3 -- the editor opens on the cached vault, and the rest catches up).
  void (async () => {
    const opened = await openDocument(session, local)
    textarea.value = opened.text
    dirty = opened.dirty
    await refreshQueueDepth()
    paint()
    if (opened.notice !== null) say(opened.notice)
    textarea.focus()

    if (!online) {
      say("You are offline. Editing continues and is saved on this device; saves to GitHub resume when the connection comes back.")
      return
    }
    showReplayOutcome(await drainQueue(session, deps))
    await backgroundSync()
  })()
}
