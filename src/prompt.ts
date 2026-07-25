import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const soulDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "soul")

/**
 * The soul file plus the Division's memos, concatenated once at boot. At roughly
 * fifteen thousand tokens this is large, but it is byte-identical on every call,
 * so it rides Anthropic's prompt cache and costs a tenth of its size after the
 * first request. That is cheaper and far simpler than standing up a vector store
 * to retrieve fragments of a corpus small enough to just hold.
 */
let cached: string | undefined

export const loadStaticPrompt = async () => {
  if (cached) return cached

  const soul = await readFile(path.join(soulDir, "soul.md"), "utf8")

  const memoDir = path.join(soulDir, "memos")
  const names = (await readdir(memoDir)).filter((n) => n.endsWith(".md")).sort()
  const memos = await Promise.all(
    names.map(async (name) => `### ${name}\n\n${await readFile(path.join(memoDir, name), "utf8")}`),
  )

  cached = `${soul}\n\n---\n\n# The record — the Division's memos\n\n${memos.join("\n\n---\n\n")}`
  return cached
}

export const petitionerContext = (opts: {
  notes: string
  summary: string
  bearing: string
  depth: string
  elevation: string
  seal: boolean
}) =>
  [
    `## What you remember of this petitioner\n${opts.notes || "Nothing is yet known of this one."}`,
    `## The audience so far\n${opts.summary || "They have only just come."}`,
    `## Your bearing this turn\n${opts.bearing}`,
    `## Depth\n${opts.depth}`,
    opts.elevation ? `## Elevation\n${opts.elevation}` : "",
    opts.seal
      ? "## Seal\nA sealed fragment is permitted this turn. Wrap exactly one short phrase in ⟦ ⟧."
      : "## Seal\nNo seal this turn. Do not use ⟦ ⟧ markers.",
    `Reply with the next utterance and nothing else. No stage directions, no quotation marks around the whole reply, no preamble.`,
  ]
    .filter(Boolean)
    .join("\n\n")
