// History view (spec §6.6's restore-as-a-new-commit, §13's no-state-dead-ends). Git is the
// vault's history, so this view is a reader over the `data` branch's commits plus one write
// path -- restore -- which is deliberately an ordinary forward commit and nothing else.
//
// Ruling R28: the decisions (what a diff is, what a version load can return, what restoring
// does) are DOM-free exports; `renderHistory` is wiring. This file has no Node types available.

import { diffIndices } from "node-diff3"
import type { GithubStore } from "../store/github"
import type { Session } from "../session/unlock"
import { decryptVault, WrongPassphraseError } from "../vault/crypto"
import { splitLines } from "../vault/merge"
import { commitDocument, type CommitOutcome, type SessionIO } from "./editor"

/** One commit on the `data` branch, as `GithubStore.history` returns it. */
export interface HistoryEntry {
  sha: string
  date: string
  message: string
}

/** How many commits one page of history asks for. The spec sets no retention bound -- a vault
 * edited daily for years has thousands of commits -- so history is paged rather than loaded
 * whole, and this is the page size. */
export const HISTORY_PAGE = 25

/** A line in the restore preview. `removed` is in the current document and not in the selected
 * version; `added` is the reverse. Framed as "what restoring would do", because that is the only
 * decision this view asks the user to make. */
export type DiffLine = { kind: "same" | "added" | "removed"; text: string }

/** Line diff between the current document and a selected older version.
 *
 * Splits with {@link splitLines} -- shared with the three-way merge rather than re-split here,
 * because that function keeps each line's own terminator attached, and splitting any other way
 * makes every line of a CRLF document differ from its own CRLF counterpart. Uses `node-diff3`'s
 * own `diffIndices`, the same library (and so the same LCS) the merge already depends on, rather
 * than a second hand-rolled diff that could disagree with it. */
export function diffLines(current: string, selected: string): DiffLine[] {
  const a = splitLines(current)
  const b = splitLines(selected)
  const out: DiffLine[] = []
  let cursor = 0

  for (const region of diffIndices(a, b)) {
    const [aStart, aLength] = region.buffer1
    for (let i = cursor; i < aStart; i++) out.push({ kind: "same", text: a[i] })
    for (const text of region.buffer1Content) out.push({ kind: "removed", text })
    for (const text of region.buffer2Content) out.push({ kind: "added", text })
    cursor = aStart + aLength
  }
  for (let i = cursor; i < a.length; i++) out.push({ kind: "same", text: a[i] })
  return out
}

/** Whether a diff contains any change at all — used to say "identical to what you have now"
 * rather than rendering an unchanged document and leaving the user to scan it. */
export function isUnchanged(diff: readonly DiffLine[]): boolean {
  return diff.every((line) => line.kind === "same")
}

/** What loading one historical version can produce. The `undecryptable` case is a named outcome
 * rather than a thrown error because spec §13 requires it to be REPORTED without blanking the
 * view: a vault encrypted under a passphrase that has since been rotated (task 17) is a real,
 * expected thing to find in a long history, not a crash. */
export type VersionLoad = { kind: "text"; text: string } | { kind: "undecryptable"; message: string }

/** Reads and decrypts the vault as of one commit. */
export async function loadVersion(sha: string, session: Session, store: GithubStore): Promise<VersionLoad> {
  let armored: string
  try {
    armored = await store.readAt(sha)
  } catch (err) {
    return {
      kind: "undecryptable",
      message: `This version could not be fetched from GitHub: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  try {
    return { kind: "text", text: await decryptVault(armored, session.passphrase) }
  } catch (err) {
    if (err instanceof WrongPassphraseError) {
      return {
        kind: "undecryptable",
        message:
          "Your current passphrase does not open this version. That is expected for versions saved before a passphrase change — the newer versions above are unaffected, and this one can still be opened with the old passphrase using `age -d`.",
      }
    }
    return {
      kind: "undecryptable",
      message: `This version could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Restores an older version by committing it forward (spec §6.6).
 *
 * Nothing here rewrites, force-pushes or deletes: the restored text becomes the newest commit,
 * with the version it replaced still reachable in the history directly above it. That is the
 * whole point -- a restore is itself undoable by restoring what it replaced. */
export async function restoreVersion(text: string, session: Session, io: SessionIO): Promise<CommitOutcome> {
  const outcome = await commitDocument(text, session, io)
  if (outcome.kind === "committed") session.text = text
  return outcome
}

/** Formats a commit's ISO date for the list. Fixed locale (`en-GB`) rather than the visitor's,
 * so the rendering is identical on every device and in every test run -- a history list is a
 * log, and a log that reads differently per machine is harder to reason about, not friendlier. */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
}

/** What {@link renderHistory} needs. */
export interface HistoryDeps {
  session: Session
  io: SessionIO
  /** Leaves history and returns to the editor on `text` (the current document if nothing was
   * restored, the restored version if something was). */
  onClose: (text: string) => void
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`history view: expected element ${selector}`)
  return el
}

/** Mounts the history view. Wiring only. */
export function renderHistory(root: HTMLElement, deps: HistoryDeps): void {
  const { session, io } = deps
  const store = session.token === null ? null : io.makeStore(session.token)

  root.classList.remove("editor-root")
  root.innerHTML = `
    <section class="history" aria-label="Version history">
      <div class="history-head">
        <h1>History</h1>
        <button type="button" id="close-history">Back to the editor</button>
      </div>
      <p id="history-feedback" class="wizard-feedback" data-testid="history-feedback" role="alert" hidden></p>
      <div class="history-body">
        <ol id="history-list" class="history-list" data-testid="history-list"></ol>
        <div id="history-detail" class="history-detail" data-testid="history-detail">
          <p>Select a version to see what restoring it would change.</p>
        </div>
      </div>
    </section>
  `

  const list = required<HTMLOListElement>(root, "#history-list")
  const detail = required<HTMLDivElement>(root, "#history-detail")
  const feedback = required<HTMLParagraphElement>(root, "#history-feedback")

  required<HTMLButtonElement>(root, "#close-history").addEventListener("click", () => deps.onClose(session.text))

  function fail(message: string): void {
    feedback.textContent = message
    feedback.hidden = false
  }

  if (store === null) {
    // spec §13: a way forward, not a blank list. Reading history is the one thing that genuinely
    // cannot work without a token, so this says so instead of showing an empty log.
    fail(
      "This device has no usable GitHub token, so history cannot be read. Your current text is unaffected — go back to the editor and set a token up again from Settings.",
    )
    return
  }

  function renderDetail(entry: HistoryEntry, load: VersionLoad): void {
    detail.replaceChildren()

    const heading = document.createElement("h2")
    heading.textContent = `${formatDate(entry.date)} · ${entry.sha.slice(0, 7)}`
    detail.append(heading)

    if (load.kind === "undecryptable") {
      // Reported in place: the list on the left is untouched and every other version stays
      // selectable, which is what "without blanking the view" means.
      const problem = document.createElement("p")
      problem.className = "wizard-feedback"
      problem.dataset.testid = "version-problem"
      problem.textContent = load.message
      detail.append(problem)
      return
    }

    const diff = diffLines(session.text, load.text)

    if (isUnchanged(diff)) {
      const same = document.createElement("p")
      same.dataset.testid = "version-unchanged"
      same.textContent = "This version is identical to what you have now."
      detail.append(same)
    } else {
      const pre = document.createElement("pre")
      pre.className = "history-diff"
      pre.dataset.testid = "version-diff"
      for (const line of diff) {
        const span = document.createElement("span")
        span.className = `diff-${line.kind}`
        // `textContent`, never interpolated: every line here is decrypted vault content.
        span.textContent = (line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  ") + line.text
        pre.append(span)
      }
      detail.append(pre)
    }

    const restore = document.createElement("button")
    restore.type = "button"
    restore.dataset.testid = "restore-btn"
    restore.textContent = "Restore this version"
    restore.addEventListener("click", () => {
      void (async () => {
        restore.disabled = true
        feedback.hidden = true
        const outcome = await restoreVersion(load.text, session, io)
        restore.disabled = false
        if (outcome.kind === "committed" || outcome.kind === "queued") {
          deps.onClose(load.text)
          return
        }
        fail(
          outcome.kind === "conflict"
            ? "Another device saved while this restore was in flight, so it was not applied. Go back to the editor and try again — nothing has been changed."
            : outcome.kind === "no-token"
              ? "This device has no usable GitHub token, so the restore could not be saved."
              : outcome.message,
        )
      })()
    })
    detail.append(restore)
  }

  void (async () => {
    // A placeholder while the commit list is in flight. Without it the list is simply empty for
    // as long as GitHub takes to answer, which is indistinguishable from "this vault has no
    // history" -- a momentary lie about the user's own data.
    const loading = document.createElement("li")
    loading.className = "history-loading"
    loading.dataset.testid = "history-loading"
    loading.textContent = "Loading versions…"
    list.append(loading)

    let entries: HistoryEntry[]
    try {
      entries = await store.history(HISTORY_PAGE)
    } catch (err) {
      loading.remove()
      fail(`History could not be read from GitHub: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    loading.remove()

    if (entries.length === 0) {
      detail.replaceChildren()
      const empty = document.createElement("p")
      empty.textContent = "This vault has no saved versions yet."
      detail.append(empty)
      return
    }

    // `history` returns newest first (GitHub's own order for `GET /commits`), which is the order
    // this list wants, so nothing re-sorts it here.
    for (const entry of entries) {
      const li = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"
      button.className = "history-entry"
      button.dataset.sha = entry.sha

      const when = document.createElement("span")
      when.className = "history-when"
      when.textContent = formatDate(entry.date)

      const what = document.createElement("span")
      what.className = "history-what"
      what.textContent = entry.message

      button.append(when, what)
      button.addEventListener("click", () => {
        void (async () => {
          feedback.hidden = true
          detail.replaceChildren()
          const loading = document.createElement("p")
          loading.textContent = "Decrypting this version…"
          detail.append(loading)
          renderDetail(entry, await loadVersion(entry.sha, session, store))
        })()
      })

      li.append(button)
      list.append(li)
    }
  })()
}
