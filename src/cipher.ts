const SEAL_MAX_LENGTH = 120
const SEAL_PATTERN = /⟦([^⟧]*)⟧/

export const caesar = (text: string, shift = 2) =>
  text.replace(/[a-z]/gi, (ch) => {
    const base = ch === ch.toUpperCase() ? 65 : 97
    return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base)
  })

/**
 * A missing marker or an over-long span degrades to plain text rather than
 * throwing — a formatting miss by the model should never cost a petitioner
 * their turn.
 */
export const applySeal = (text: string) => {
  const match = text.match(SEAL_PATTERN)
  if (!match) return text
  const inner = match[1]
  if (inner.length > SEAL_MAX_LENGTH) return text.replace(SEAL_PATTERN, inner)
  return text.replace(SEAL_PATTERN, `⟦${caesar(inner)}⟧`)
}

/** Strips markers without enciphering, for replies where no seal was permitted. */
export const stripSeal = (text: string) => text.replace(/[⟦⟧]/g, "")
