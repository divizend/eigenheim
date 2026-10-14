import { merge3 } from "../../src/vault/merge"

test("non-overlapping edits merge cleanly", () => {
  const r = merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")
  expect(r).toEqual({ text: "A\nb\nC\n", conflicted: false })
})
test("overlapping edits conflict and show both sides", () => {
  const r = merge3("a\n", "mine\n", "theirs\n")
  expect(r.conflicted).toBe(true)
  expect(r.text).toContain("mine")
  expect(r.text).toContain("theirs")
})
test("a one-sided edit takes that side", () => {
  expect(merge3("a\n", "a\n", "b\n")).toEqual({ text: "b\n", conflicted: false })
  expect(merge3("a\n", "b\n", "a\n")).toEqual({ text: "b\n", conflicted: false })
})
test("empty base — the first commit after setup", () => {
  expect(merge3("", "mine\n", "").text).toBe("mine\n")
})
test("identical sides never conflict", () => {
  expect(merge3("a\n", "b\n", "b\n")).toEqual({ text: "b\n", conflicted: false })
})
test("CRLF text merges without \\r corruption or spurious conflict", () => {
  // Review Focus 1: text pasted from Windows/Word
  const r = merge3("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nb\r\n")
  expect(r.conflicted).toBe(false)
  expect(r.text).toBe("A\r\nb\r\n")
})
test("a two-sided CRLF conflict keeps the markers CRLF too, not mixed with bare LF", () => {
  // Review Focus 1, conflict path: the test above never reaches a conflict
  // (theirs is byte-identical to base), so it can't catch marker lines
  // defaulting to "\n" while CRLF content lines merge in around them.
  const r = merge3("a\r\n", "mine\r\n", "theirs\r\n")
  expect(r.conflicted).toBe(true)
  expect(r.text).toBe("<<<<<<< mine\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> theirs\r\n")
})
test("a CRLF conflict region gets CRLF markers even in an otherwise-LF document", () => {
  // The document as a whole is LF-dominant (ten unconflicted "x\n" lines);
  // only the one conflicting line is CRLF. The markers must follow that
  // region's own convention, not the document-wide majority -- a
  // document-wide-only choice would render bare-LF markers around CRLF
  // content here.
  const base = "x\n".repeat(10) + "a\r\n"
  const mine = "x\n".repeat(10) + "mine\r\n"
  const theirs = "x\n".repeat(10) + "theirs\r\n"
  const r = merge3(base, mine, theirs)
  expect(r.conflicted).toBe(true)
  expect(r.text).toBe("x\n".repeat(10) + "<<<<<<< mine\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> theirs\r\n")
})
test("a conflict on a document's unterminated last line doesn't glue content to a marker", () => {
  // "b"/"B"/"C" are each their document's last line with no trailing
  // newline. Without a terminator inserted before "=======", the output
  // would read "B=======" as one unreadable glued line.
  const r = merge3("a\nb", "a\nB", "a\nC")
  expect(r.conflicted).toBe(true)
  expect(r.text).toBe("a\n<<<<<<< mine\nB\n=======\nC\n>>>>>>> theirs\n")
})
test("a single-line document with no terminator anywhere still renders readable markers", () => {
  const r = merge3("a", "mine", "theirs")
  expect(r.conflicted).toBe(true)
  expect(r.text).toBe("<<<<<<< mine\nmine\n=======\ntheirs\n>>>>>>> theirs\n")
})
