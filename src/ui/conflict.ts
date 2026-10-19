// Conflict view (spec §6.5's "nothing is discarded unseen", §13's every-failure-has-a-way-
// forward). Reached when an explicit save is refused because another device committed first --
// the one moment this app asks the user to make a judgement rather than just showing them their
// own text.
//
// The governing rule, and the reason this view exists at all rather than an "overwrite?" prompt:
// at the moment a conflict is detected there are two versions of the document that a human
// wrote, and the app is not entitled to destroy either of them on the user's behalf. So all
// three inputs are shown, the merge is offered as an editable starting point rather than an
// answer, and no path out of this view silently drops a side.
//
// Ruling R28: every decision lives in the exported DOM-free functions below; `renderConflict` is
// wiring. This file has no Node types available (tsconfig.app.json covers `src/`).

import type { Conflict } from "../session/sync"
import type { Session } from "../session/unlock"
import { autosaveDraft, commitDocument, type CommitOutcome, type SessionIO } from "./editor"

/** Which version the user chose. `merged` carries whatever is in the editable pane at the time,
 * which may be the three-way merge verbatim, the merge with conflict markers resolved by hand,
 * or something the user typed from scratch -- all three are "the merged pane" as far as this
 * view is concerned. */
export type Choice = "merged" | "mine" | "theirs"

/** The text a choice resolves to.
 *
 * `editedMerged` is passed in rather than read from `conflict.merged` so that edits made in the
 * merged pane are what gets committed -- the pane is editable precisely so a user can resolve
 * `<<<<<<<` markers by hand, and committing `conflict.merged` instead would throw that work
 * away at the last step. */
export function resolutionText(conflict: Conflict, choice: Choice, editedMerged: string): string {
  if (choice === "mine") return conflict.mine
  if (choice === "theirs") return conflict.theirs
  return editedMerged
}

/** Whether `text` still carries any of the three conflict-marker lines `merge3` emits.
 *
 * Matched at line starts with the multiline flag, rather than by `includes`, because a vault is
 * a plain text document and a line *about* conflict markers ("git prints <<<<<<< when...") is
 * ordinary content a user may legitimately have written. `merge3` only ever emits these at the
 * start of a line of its own -- `grep -n 'pushMarker(parts' src/vault/merge.ts` shows its three
 * call sites emitting exactly `<<<<<<< mine`, `=======` and `>>>>>>> theirs`. */
export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7} mine|={7}$|>{7} theirs)/m.test(text)
}

/** The one-line explanation above the panes. Says what happened and what is at stake, in that
 * order, because a user arriving here clicked Save and expected it to just work. */
export function conflictHeadline(conflict: Conflict): string {
  return conflict.conflicted
    ? "Another device saved a different version while you were editing, and the two changes overlap. Both versions are below — nothing has been discarded. Edit the merged version to settle the marked lines, or keep one side whole."
    : "Another device saved a different version while you were editing. The changes did not overlap, so they have been merged for you below — check it, then save."
}

/** Commits a resolution on the NEW base.
 *
 * The rebase onto `conflict.theirsSha` is the whole reason that field exists (it was added to
 * {@link Conflict} for this view): `commit` derives its base from the draft or the session, and
 * both still hold the sha that was just refused, so committing without this would be refused
 * again, forever, with no way out of this view. Spec §6.6's "never rewrites history" still
 * holds -- this is an ordinary forward commit whose parent is the version that won the race.
 *
 * The draft is written BEFORE the commit is attempted, and that ordering is load-bearing in the
 * same way Task 13's was: the commit can fail (offline, a third device landing in between), and
 * if it does, the user's resolution must already be on disk rather than living only in a DOM
 * node belonging to a view that is about to be replaced. Writing it also moves the draft's own
 * `baseSha` forward, which is what `commit` then reads. */
export async function resolveConflict(
  text: string,
  conflict: Conflict,
  session: Session,
  io: SessionIO,
): Promise<CommitOutcome> {
  session.baseSha = conflict.theirsSha
  await autosaveDraft(text, session, io.local)

  const outcome = await commitDocument(text, session, io)
  if (outcome.kind === "committed") session.text = text
  return outcome
}

/** What {@link renderConflict} needs. `onResolved` hands the settled text back to whoever owns
 * the screen (src/main.ts re-mounts the editor on it), matching the `onComplete`/`onUnlocked`
 * convention the other views already use. */
export interface ConflictDeps {
  conflict: Conflict
  session: Session
  io: SessionIO
  onResolved: (text: string) => void
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (!el) throw new Error(`conflict view: expected element ${selector}`)
  return el
}

/** Mounts the conflict view. Wiring only.
 *
 * Every pane is filled with `.value`/`.textContent`, never interpolated into the HTML template:
 * all three are decrypted vault content, and the same rule the setup wizard applies to the
 * passphrase applies here -- user text never becomes markup. */
export function renderConflict(root: HTMLElement, deps: ConflictDeps): void {
  const { conflict } = deps

  root.classList.remove("editor-root")
  root.innerHTML = `
    <section class="conflict" aria-label="Resolve a save conflict">
      <h1>Two versions</h1>
      <p id="conflict-headline" data-testid="conflict-headline"></p>
      <p id="conflict-feedback" class="wizard-feedback" data-testid="conflict-feedback" role="alert" hidden></p>

      <div class="conflict-panes">
        <div class="conflict-pane">
          <h2>Yours (not yet saved)</h2>
          <pre data-testid="pane-mine"></pre>
          <button type="button" id="keep-mine">Keep mine</button>
        </div>
        <div class="conflict-pane">
          <h2>Theirs (already on GitHub)</h2>
          <pre data-testid="pane-theirs"></pre>
          <button type="button" id="keep-theirs">Keep theirs</button>
        </div>
      </div>

      <details class="conflict-base">
        <summary>The version you both started from</summary>
        <pre data-testid="pane-base"></pre>
      </details>

      <h2>Merged — edit this, then save</h2>
      <p id="marker-note" class="conflict-marker-note" data-testid="marker-note" hidden></p>
      <textarea id="merged" class="conflict-merged" data-testid="pane-merged" spellcheck="false" aria-label="Merged version"></textarea>

      <div class="wizard-actions">
        <button type="button" id="save-merged">Save merged version</button>
      </div>
    </section>
  `

  required<HTMLParagraphElement>(root, "#conflict-headline").textContent = conflictHeadline(conflict)
  required<HTMLPreElement>(root, '[data-testid="pane-mine"]').textContent = conflict.mine
  required<HTMLPreElement>(root, '[data-testid="pane-theirs"]').textContent = conflict.theirs
  required<HTMLPreElement>(root, '[data-testid="pane-base"]').textContent = conflict.base

  const merged = required<HTMLTextAreaElement>(root, "#merged")
  merged.value = conflict.merged

  const markerNote = required<HTMLParagraphElement>(root, "#marker-note")
  const feedback = required<HTMLParagraphElement>(root, "#conflict-feedback")

  function refreshMarkerNote(): void {
    const present = hasConflictMarkers(merged.value)
    markerNote.hidden = !present
    markerNote.textContent = present
      ? "This still contains conflict markers (<<<<<<< mine / ======= / >>>>>>> theirs). You can save it as-is and tidy it later, or settle those lines now."
      : ""
  }
  refreshMarkerNote()
  merged.addEventListener("input", refreshMarkerNote)

  let running = false
  async function choose(choice: Choice): Promise<void> {
    if (running) return
    running = true
    feedback.hidden = true
    const text = resolutionText(conflict, choice, merged.value)

    const outcome = await resolveConflict(text, conflict, deps.session, deps.io)
    running = false

    if (outcome.kind === "committed" || outcome.kind === "queued") {
      // `queued` is a success from here: the resolution is encrypted and durably queued, and the
      // editor shows "saved on this device only" until it lands. Keeping the user trapped in
      // this view until the network returns would be its own dead end (spec §13), and the
      // conflict itself is already settled -- re-deciding it later would be asking twice.
      deps.onResolved(text)
      return
    }

    if (outcome.kind === "conflict") {
      // A THIRD version arrived while this one was being resolved. Re-open on the fresh inputs
      // rather than failing: the brief's own requirement ("if that also conflicts, the same view
      // reopens with fresh inputs rather than failing"), and the alternative would be a view
      // whose only button no longer does anything.
      renderConflict(root, { ...deps, conflict: outcome.conflict })
      return
    }

    feedback.textContent =
      outcome.kind === "no-token"
        ? "This device has no usable GitHub token, so the resolution cannot be saved to GitHub. It is saved on this device and will be sent once a token is set up again."
        : outcome.message
    feedback.hidden = false
  }

  required<HTMLButtonElement>(root, "#keep-mine").addEventListener("click", () => void choose("mine"))
  required<HTMLButtonElement>(root, "#keep-theirs").addEventListener("click", () => void choose("theirs"))
  required<HTMLButtonElement>(root, "#save-merged").addEventListener("click", () => void choose("merged"))
}
