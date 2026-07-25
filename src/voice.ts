const TTS_URL = `${process.env.LLM_BASE_URL ?? "https://api.ppq.ai/v1"}/audio/speech`

// Brian: deep, resonant, middle-aged. Swap via env — Callum (N2lVS1w4EtoT3dr4eOWO)
// is gravellier and stranger if the delivery should unsettle rather than reassure.
const VOICE_ID = process.env.VOICE_ID ?? "nPczCjzI2devNBz1zQrb"
const TTS_MODEL = process.env.TTS_MODEL ?? "eleven_flash_v2_5"

/** Roughly how often a spoken reply replaces a written one. */
export const VOICE_CHANCE = Number(process.env.VOICE_CHANCE ?? 0.15)

// Long passages are slow to synthesise and tedious to listen to, and a listener
// cannot skim back over one the way they can a message.
const MAX_SPOKEN_LENGTH = 420

/**
 * Read aloud, a sealed fragment is just noise — the cipher is a thing you look
 * at. Markdown and the seal markers themselves would also be voiced literally.
 */
export const speakable = (text: string) =>
  !text.includes("⟦") &&
  text.length <= MAX_SPOKEN_LENGTH &&
  // A domain read aloud is a mouthful, and it is the one thing a listener would
  // most want to copy — so anything pointing at the site stays written.
  !/https?:\/\/|\b[\w-]+\.(com|xyz|io|app|net|org)\b/i.test(text)

export const synthesize = async (text: string): Promise<Buffer | undefined> => {
  const key = process.env.LLM_API_KEY
  if (!key) return undefined

  try {
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice: VOICE_ID }),
    })
    if (!res.ok) {
      console.error(`tts failed ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return undefined
    }
    return Buffer.from(await res.arrayBuffer())
  } catch (err) {
    console.error("tts error:", (err as Error)?.message)
    return undefined
  }
}
