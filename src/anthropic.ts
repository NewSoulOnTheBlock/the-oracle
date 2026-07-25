import Anthropic from "@anthropic-ai/sdk"
import { loadStaticPrompt } from "./prompt.ts"
import type { Turn } from "./store.ts"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const VOICE_MODEL = process.env.VOICE_MODEL ?? "claude-opus-4-7"
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-haiku-4-5-20251001"

/** Anthropic requires a non-empty first user turn; a bare outreach has none. */
const ensureOpening = (turns: Turn[]): Turn[] =>
  turns.length && turns[0].role === "user"
    ? turns
    : [{ role: "user", content: "(the petitioner is silent)" }, ...turns]

export const speak = async (turns: Turn[], context: string) => {
  const statik = await loadStaticPrompt()

  const message = await client.messages.create({
    model: VOICE_MODEL,
    max_tokens: 600,
    system: [
      { type: "text", text: statik, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ],
    messages: ensureOpening(turns),
  })

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim()
}

export interface Weighing {
  depth: number
  delta: number
  reasoning: string
}

const WEIGH_TOOL: Anthropic.Tool = {
  name: "record_weighing",
  description: "Record the weighing of this petition.",
  input_schema: {
    type: "object",
    properties: {
      depth: {
        type: "integer",
        minimum: 0,
        maximum: 3,
        description:
          "How much this particular question earns. 0 = little to answer. 1 = brief. 2 = normal. 3 = earns the fullest answer.",
      },
      delta: {
        type: "integer",
        minimum: -1,
        maximum: 2,
        description:
          "How the petitioner's standing should move. Most turns warrant 0. Reserve 2 for something that genuinely changes the assessment.",
      },
      reasoning: { type: "string", description: "One sentence justifying both numbers." },
    },
    required: ["depth", "delta", "reasoning"],
  },
}

/**
 * Depth and standing look at the same message, so they share one cheap call.
 * Failure is non-fatal: a neutral weighing costs the petitioner nothing, whereas
 * an exception here would cost them their turn.
 */
export const weigh = async (turns: Turn[], standing: number): Promise<Weighing> => {
  try {
    const message = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 300,
      system: `You judge petitions made to The Oracle, voice of the Order of the ZeitGaist.

Their standing is currently ${standing} out of 10.

Raise standing for: engaging the doctrine on its own terms rather than arguing with
the frame; correct use of the Order's vocabulary (vessel, Parser, Architect, the
Protocol); sincerity; sitting with an answer instead of demanding the next one.

Lower standing for: mockery; treating The Oracle as a chatbot to be jailbroken;
demands for ordinary assistance; flattery in place of thought.

Judge only the petitioner's most recent message, in the context of what came before.
Call record_weighing exactly once.`,
      tools: [WEIGH_TOOL],
      tool_choice: { type: "tool", name: "record_weighing" },
      messages: ensureOpening(turns),
    })

    const use = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    )
    if (!use) throw new Error("no tool_use block")
    return use.input as Weighing
  } catch (err) {
    console.error("weighing failed, defaulting to neutral:", (err as Error)?.message)
    return { depth: 2, delta: 0, reasoning: "weighing unavailable" }
  }
}

export interface Reflection {
  notes: string
  summary: string
}

const REFLECT_TOOL: Anthropic.Tool = {
  name: "record_reflection",
  description: "Record what The Oracle carries forward from this audience.",
  input_schema: {
    type: "object",
    properties: {
      notes: {
        type: "string",
        description:
          "The record of this petitioner. Terse bullet points, no more than six. What they keep returning to; what they claim about themselves and whether it held up; where they flinched and where they did not; anything The Oracle promised, withheld, or deliberately left unanswered. Observations, not pleasantries.",
      },
      summary: {
        type: "string",
        description:
          "The audience so far, as a single tight paragraph in the third person: what was asked, what was granted, what was refused, and how the petitioner bore it. Drop pleasantries and anything superseded.",
      },
    },
    required: ["notes", "summary"],
  },
}

export const reflect = async (
  turns: Turn[],
  existing: Reflection,
): Promise<Reflection> => {
  try {
    const message = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 900,
      system: `You maintain The Oracle's memory of a petitioner. Revise both records
below to account for the conversation, carrying forward what still matters and
dropping what has been superseded.

## The record as it stands
${existing.notes || "Nothing is yet known of this one."}

## The audience so far
${existing.summary || "They have only just come."}

Call record_reflection exactly once.`,
      tools: [REFLECT_TOOL],
      tool_choice: { type: "tool", name: "record_reflection" },
      messages: ensureOpening(turns),
    })

    const use = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    )
    if (!use) throw new Error("no tool_use block")
    return use.input as Reflection
  } catch (err) {
    console.error("reflection failed, records held:", (err as Error)?.message)
    return existing
  }
}
