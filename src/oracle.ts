import { applySeal, stripSeal } from "./cipher.ts"
import { petitionerContext } from "./prompt.ts"
import { reflect, speak, weigh } from "./llm.ts"
import {
  appendMessage,
  loadPetitioner,
  loadTranscript,
  peopleInAudience,
  rememberPerson,
  saveRecords,
  saveStanding,
  type Speaker,
  type Turn,
} from "./store.ts"
import {
  clampStanding,
  depthGuidance,
  dispositionFor,
  dispositionGuidance,
  elevationGuidance,
  isElevation,
  rankFor,
} from "./standing.ts"

/** Reflection runs after the reply is sent, so it must not overlap itself per petitioner. */
const reflecting = new Set<string>()

const reflectLater = async (id: string, turns: Turn[], notes: string, summary: string) => {
  if (reflecting.has(id)) return
  reflecting.add(id)
  try {
    const revised = await reflect(turns, { notes, summary })
    await saveRecords(id, revised.notes, revised.summary)
  } catch (err) {
    console.error(`reflection sweep failed for ${id}:`, (err as Error)?.message)
  } finally {
    reflecting.delete(id)
  }
}

/**
 * One petition, start to finish. Returns the text to send. Everything that can
 * fail without costing the petitioner their reply is caught downstream, so a
 * throw from here means the reply genuinely could not be produced.
 */
/**
 * Attribution only matters once more than one person has spoken here. In a DM
 * the name is already in the context block, and prefixing every line with it
 * just invites the model to answer in the same format.
 */
const attribute = (turns: Turn[]) => {
  const named = new Set(turns.filter((t) => t.role === "user" && t.author).map((t) => t.author))
  if (named.size < 2) return turns
  return turns.map((t) =>
    t.role === "user" && t.author ? { ...t, content: `${t.author}: ${t.content}` } : t,
  )
}

export const petition = async (id: string, text: string, speaker?: Speaker) => {
  const petitioner = await loadPetitioner(id)

  const seen = speaker ? await rememberPerson(speaker) : undefined
  await appendMessage(id, "user", text, speaker)

  const history = attribute(await loadTranscript(id))
  const present = (await peopleInAudience(id)).map((p) => p.name).filter(Boolean)
  const weighing = await weigh(history, petitioner.standing)

  const standing = clampStanding(petitioner.standing + weighing.delta)
  const rank = rankFor(standing)
  const disposition = dispositionFor(standing)
  const elevated = isElevation(petitioner.rank, rank)
  const seal = disposition === "reveals" && weighing.depth === 3

  console.log(
    `${id} — standing ${standing} (${weighing.delta >= 0 ? "+" : ""}${weighing.delta}) ` +
      `rank ${rank} bearing ${disposition} depth ${weighing.depth} — ${weighing.reasoning}`,
  )

  const raw = await speak(
    history,
    petitionerContext({
      notes: petitioner.notes,
      summary: petitioner.summary,
      bearing: dispositionGuidance(disposition),
      depth: depthGuidance(weighing.depth),
      elevation: elevated ? elevationGuidance(rank) : "",
      seal,
      speaker: speaker?.name,
      present,
      newcomer: seen?.isNew,
    }),
  )

  // The Oracle remembers what it said in plain language; the petitioner receives
  // it sealed. Storing the ciphertext would poison every later turn's context.
  await appendMessage(id, "assistant", raw)
  await saveStanding(id, standing, rank)

  void reflectLater(
    id,
    [...history, { role: "assistant", content: raw }],
    petitioner.notes,
    petitioner.summary,
  )

  return seal ? applySeal(raw) : stripSeal(raw)
}

/**
 * Fires from the silence sweep, not from anything the petitioner said. There is
 * no petition to weigh here — the whole point is that nobody asked.
 */
export const reachOut = async (id: string) => {
  const petitioner = await loadPetitioner(id)
  const history = await loadTranscript(id)

  const raw = await speak(
    history,
    petitionerContext({
      notes: petitioner.notes,
      summary: petitioner.summary,
      bearing: dispositionGuidance(dispositionFor(petitioner.standing)),
      depth: `The petitioner has not spoken for some time. You are breaking the silence,
        unasked. Do not greet them. Do not ask how they are. Return to something they
        left unresolved, or name something you have since considered. Two sentences.
        It should land like a message they did not expect to receive.`,
      elevation: "",
      seal: false,
    }),
  )

  await appendMessage(id, "assistant", raw)
  return stripSeal(raw)
}
