import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { petition } from "./oracle.ts"
import { historyForPerson, listPeople } from "./store.ts"

export const PETITION_PATH = "/v1/petition"
export const PEOPLE_PATH = "/v1/people"

const MAX_MESSAGE_LENGTH = 2000
const MAX_BODY_BYTES = 8 * 1024

// A public endpoint in front of a metered model is a way to lose money, so the
// limits are deliberately tight. Raise them once real traffic justifies it.
const PER_SESSION_PER_MINUTE = 6
const GLOBAL_PER_MINUTE = 60

const hits = new Map<string, number[]>()

const rateLimited = (key: string, limit: number) => {
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= limit) {
    hits.set(key, recent)
    return true
  }
  recent.push(now)
  hits.set(key, recent)
  return false
}

// Unbounded growth otherwise: every session id ever seen would keep an entry.
setInterval(() => {
  const now = Date.now()
  for (const [key, times] of hits) {
    const recent = times.filter((t) => now - t < 60_000)
    if (recent.length) hits.set(key, recent)
    else hits.delete(key)
  }
}, 60_000).unref()

const authorized = (req: IncomingMessage) => {
  const expected = process.env.ORACLE_API_KEY
  if (!expected) return false

  const header = req.headers.authorization ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Session ids come from the caller, so they are sanitised and forced under a
 * `web:` prefix. Without this a caller could pass `tg:<chat id>` and read or
 * poison somebody's Telegram audience.
 */
const petitionerId = (session: unknown) => {
  const raw = typeof session === "string" ? session : ""
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)
  return safe ? `web:${safe}` : ""
}

const json = (res: ServerResponse, status: number, body: unknown, origin?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (origin) {
    headers["access-control-allow-origin"] = origin
    headers["vary"] = "Origin"
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

/** Empty ALLOWED_ORIGINS means server-to-server only, which is the safer default. */
const allowedOrigin = (req: IncomingMessage) => {
  const allowed = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
  const origin = req.headers.origin
  if (!origin || !allowed.length) return undefined
  return allowed.includes(origin) || allowed.includes("*") ? origin : undefined
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

/**
 * Read-only view of who The Oracle has met. The database takes no external
 * connections, so without this the recorded names and history are unreachable.
 */
export const handlePeople = async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== "GET") return json(res, 405, { error: "method not allowed" })
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" })

  const url = new URL(req.url ?? "", "http://local")
  const person = url.searchParams.get("id")

  try {
    if (person) {
      return json(res, 200, { id: person, history: await historyForPerson(person) })
    }
    return json(res, 200, { people: await listPeople() })
  } catch (err) {
    console.error("people lookup failed:", (err as Error)?.message)
    return json(res, 500, { error: "lookup failed" })
  }
}

export const handlePetition = async (req: IncomingMessage, res: ServerResponse) => {
  const origin = allowedOrigin(req)

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin ?? "",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "86400",
    })
    res.end()
    return
  }

  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" }, origin)
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" }, origin)

  let payload: { session?: unknown; message?: unknown; name?: unknown }
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    return json(res, 400, { error: "invalid json body" }, origin)
  }

  const id = petitionerId(payload.session)
  if (!id) {
    return json(res, 400, { error: "session must be 1-64 chars of [A-Za-z0-9_-]" }, origin)
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : ""
  if (!message) return json(res, 400, { error: "message is required" }, origin)
  if (message.length > MAX_MESSAGE_LENGTH) {
    return json(res, 413, { error: `message exceeds ${MAX_MESSAGE_LENGTH} characters` }, origin)
  }

  if (rateLimited("global", GLOBAL_PER_MINUTE) || rateLimited(id, PER_SESSION_PER_MINUTE)) {
    return json(res, 429, { error: "too many petitions; wait a moment" }, origin)
  }

  // The caller supplies the display name, so it is length-capped and stripped of
  // control characters before it can reach a prompt or the database.
  const name =
    typeof payload.name === "string"
      ? payload.name.replace(/[\p{C}]/gu, "").trim().slice(0, 60)
      : ""

  try {
    const reply = await petition(id, message, { id, name: name || "an unnamed petitioner" })
    return json(res, 200, { reply, session: id.slice(4) }, origin)
  } catch (err) {
    console.error(`web petition failed for ${id}:`, (err as Error)?.message)
    return json(res, 502, { error: "the transmission faltered" }, origin)
  }
}
