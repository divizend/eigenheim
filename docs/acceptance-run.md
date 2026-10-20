# Acceptance run (spec §14)

Run at 2026-10-20T08:34:02.815Z against a REAL private GitHub repository (`sigalor/eigenheim-acceptance-1792485233`, deleted at the end), a REAL Chromium running the production bundle, and the REAL `age` binary. Nothing below was mocked.

Not covered here, because no script can honestly perform them: §14.1 (a human clicking Deploy on Vercel), §14.2 (creating a fine-grained token in GitHub's web UI — GitHub has no API for minting one), and §14.11 (pointing a personal domain at the deployment). Because the wizard correctly refuses classic tokens, §14.3 and §14.7 are covered against the production bundle in a real browser by the E2E suite rather than live here.

- **§14 setup** created the orphan `data` branch on `sigalor/eigenheim-acceptance-1792485233` through the app's own storage layer (commit `6f85e1d`).
- **§14.4** typed text into the editor, saved it to GitHub with Ctrl+S, reloaded the page, unlocked again — and the same text came back, decrypted in the browser.
- **§14.5** the `data` branch holds exactly `README.md` and `vault.age`. The blob begins `-----BEGIN AGE ENCRYPTED FILE-----` and contains no fragment of the plaintext (checked for "the only file", "日本語" and the emoji). The README is plaintext: "# This is an encrypted vault, not application source".
- **§14.6** **downloaded the committed blob from github.com and decrypted it with the official `age` v1.3.2 binary, using only the passphrase — no part of this app involved.** It returned the exact bytes typed in the browser, byte-for-byte, including Unicode and the emoji. This is the step the spec calls "the difference between sovereignty and a slogan".
- **§14.8** two independent browser profiles edited from the same base. GitHub refused the second write rather than overwriting (fast-forward-only), the conflict view showed both versions side by side, and the resolution kept BOTH lines. Nothing was lost or silently discarded.
- **§14.9** went offline, kept editing, saved into the local queue, then reconnected — the queued save reached GitHub on its own, confirmed by reading the branch head back and decrypting it.
- **§14.10** restored the oldest version from history and got its exact contents back. It was written as a NEW commit: the branch went from 5 to 6 commits, so nothing was rewritten and the restore is itself undoable.

**Result: §14.4, §14.5, §14.6, §14.8, §14.9 and §14.10 all passed against real GitHub, a real browser running the production bundle, and the real age binary.** §14.3 and §14.7 are covered against the same production bundle in a real browser by the E2E suite (a live run of the wizard's token step needs a fine-grained PAT, which only a human can create). §14.1, §14.2 and §14.11 need a human with a Vercel account, a GitHub web session and the domain's DNS respectively.
