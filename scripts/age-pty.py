#!/usr/bin/env python3
"""Run the real `age` binary under a pty, answering its passphrase prompts.

`age` reads passphrases from /dev/tty, never from stdin, so a plain pipe cannot drive it
(confirmed live: `printf 'x' | age -p -a -o out in` fails with "standard input is not a
terminal, and /dev/tty is not available"). Every automated use of the real binary in this
repo therefore needs a pty, which is what this provides.

Usage:  AGE_PASSPHRASE=... age-pty.py <age-binary> [args...]
Exits with age's own exit status, so a genuine failure fails the caller.

The same technique is inlined in scripts/make-fixtures.sh, which predates this file and
generates the committed inbound-interop fixtures. It is left as it is deliberately: that script
is run by hand only when fixtures are regenerated, and rewriting a working generator of
checked-in artifacts to share code carries more risk than the duplication does.
"""
import os
import select
import sys
import time
import pty

passphrase = (os.environ["AGE_PASSPHRASE"] + "\n").encode()
age_bin, *args = sys.argv[1:]

pid, fd = pty.fork()
if pid == 0:
    os.execv(age_bin, [age_bin, *args])
    os._exit(127)

buf = b""
sent_enter = sent_confirm = False
deadline = time.time() + 60
status = None
while True:
    if time.time() > deadline:
        os.kill(pid, 9)
        sys.exit("age-pty.py: timed out waiting for age's passphrase prompt")
    ready, _, _ = select.select([fd], [], [], 1)
    if fd in ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            break
        buf += chunk
        # `-d` prompts once; `-p` prompts twice. Both are handled so this one helper covers
        # either direction of the interop check.
        if b"Enter passphrase" in buf and not sent_enter:
            os.write(fd, passphrase)
            sent_enter, buf = True, b""
        elif b"Confirm passphrase" in buf and not sent_confirm:
            os.write(fd, passphrase)
            sent_confirm, buf = True, b""
    wpid, raw = os.waitpid(pid, os.WNOHANG)
    if wpid != 0:
        status = raw
        break

if status is None:
    # The loop can end on EOF (the pty closed) before WNOHANG observed the exit. Block for the
    # real status rather than falling off the end with an implicit 0: a genuine age failure must
    # fail the caller, not look like success.
    _, status = os.waitpid(pid, 0)

sys.exit(os.WEXITSTATUS(status))
