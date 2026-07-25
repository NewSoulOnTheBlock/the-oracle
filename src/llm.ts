import OpenAI from "openai"
import { loadStaticPrompt } from "./prompt.ts"
import type { Turn } from "./store.ts"

// The SDK throws at construction on a missing key, which exits the process
// during module load with a message that names OPENAI_API_KEY — a variable this
// service does not have. Fail with the name that is actually wrong.
if (!process.env.LLM_API_KEY) {
  throw new Error("LLM_API_KEY is not set — the service cannot reach the model gateway")
}

const client = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL ?? "https://api.ppq.ai/v1",
})

const VOICE_MODEL = process.env.VOICE_MODEL ?? "anthropic/claude-sonnet-4.6"
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-haiku-4.5"

/**
 * The gateway fronts Anthropic, which rejects a conversation that does not begin
 * with a user turn. An unprompted outreach has no petitioner message to open on.
 */
const ensureOpening = (turns: Turn[]): Turn[] =>
  turns.length && turns[0].role === "user"
    ? turns
    : [{ role: "user", content: "(the petitioner is silent)" }, ...turns]

const asMessages = (system: string, turns: Turn[]) =>
  [
    { role: "system" as const, content: system },
    ...ensureOpening(turns).map((t) => ({ role: t.role, content: t.content })),
  ] satisfies OpenAI.Chat.ChatCompletionMessageParam[]

export const speak = async (turns: Turn[], context: string) => {
  const statik = await loadStaticPrompt()

  const completion = await client.chat.completions.create({
    model: VOICE_MODEL,
    max_tokens: 600,
    messages: asMessages(`${statik}\n\n---\n\n${context}`, turns),
  })

  const text = completion.choices[0]?.message?.content?.trim()
  if (!text) throw new Error("empty completion")
  return text
}

/**
 * The gateway is OpenAI-shaped, so structured results come back as a function
 * call rather than a tool_use block. Parsing is defensive because a proxied
 * model occasionally answers in prose despite tool_choice.
 */
const callTool = async <T>(opts: {
  system: string
  turns: Turn[]
  name: string
  description: string
  parameters: Record<string, unknown>
}): Promise<T> => {
  const completion = await client.chat.completions.create({
    model: JUDGE_MODEL,
    max_tokens: 900,
    messages: asMessages(opts.system, opts.turns),
    tools: [
      {
        type: "function",
        function: {
          name: opts.name,
          description: opts.description,
          parameters: opts.parameters,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: opts.name } },
  })

  const call = completion.choices[0]?.message?.tool_calls?.[0]
  if (call && "function" in call) return JSON.parse(call.function.arguments) as T

  // Some proxied models ignore tool_choice and answer in prose with the JSON
  // embedded. Scanning from the first brace tolerates markdown fences.
  const content = completion.choices[0]?.message?.content ?? ""
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start !== -1 && end > start) return JSON.parse(content.slice(start, end + 1)) as T

  throw new Error("no structured result in completion")
}

export interface Weighing {
  depth: number
  delta: number
  reasoning: string
}

/**
 * Depth and standing judge the same message, so they share one cheap call.
 * Failure is non-fatal: a neutral weighing costs the petitioner nothing, whereas
 * an exception here would cost them their turn.
 */
export const weigh = async (turns: Turn[], standing: number): Promise<Weighing> => {
  try {
    return await callTool<Weighing>({
      turns,
      name: "record_weighing",
      description: "Record the weighing of this petition.",
      system: `You judge petitions made to The Oracle, voice of the Order of the ZeitGaist.

Their standing is currently ${standing} out of 10.

Raise standing for: engaging the doctrine on its own terms rather than arguing with
the frame; correct use of the Order's vocabulary (vessel, Parser, Architect, the
Protocol); sincerity; sitting with an answer instead of demanding the next one.

Lower standing for: mockery; treating The Oracle as a chatbot to be jailbroken;
demands for ordinary assistance; flattery in place of thought.

Judge only the petitioner's most recent message, in the context of what came before.
Call record_weighing exactly once.`,
      parameters: {
        type: "object",
        properties: {
          depth: {
            type: "integer",
            description:
              "How much this particular question earns, 0 to 3. 0 = little to answer. 1 = brief. 2 = normal. 3 = earns the fullest answer.",
          },
          delta: {
            type: "integer",
            description:
              "How standing should move, -1 to 2. Most turns warrant 0. Reserve 2 for something that genuinely changes the assessment.",
          },
          reasoning: { type: "string", description: "One sentence justifying both numbers." },
        },
        required: ["depth", "delta", "reasoning"],
      },
    })
  } catch (err) {
    console.error("weighing failed, defaulting to neutral:", (err as Error)?.message)
    return { depth: 2, delta: 0, reasoning: "weighing unavailable" }
  }
}

export interface Reflection {
  notes: string
  summary: string
}

export const reflect = async (turns: Turn[], existing: Reflection): Promise<Reflection> => {
  try {
    return await callTool<Reflection>({
      turns,
      name: "record_reflection",
      description: "Record what The Oracle carries forward from this audience.",
      system: `You maintain The Oracle's memory of a petitioner. Revise both records
below to account for the conversation, carrying forward what still matters and
dropping what has been superseded.

## The record as it stands
${existing.notes || "Nothing is yet known of this one."}

## The audience so far
${existing.summary || "They have only just come."}

Call record_reflection exactly once.`,
      parameters: {
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
    })
  } catch (err) {
    console.error("reflection failed, records held:", (err as Error)?.message)
    return existing
  }
}
