import { createServer } from "node:http"
import {
  WEBHOOK_PATH,
  createBot,
  registerWebhook,
  startPolling,
  useWebhook,
  webhookHandler,
} from "./telegram.ts"
import { PEOPLE_PATH, PETITION_PATH, handlePeople, handlePetition } from "./api.ts"
import { reachOut } from "./oracle.ts"
import { dueForOutreach, markOutreach, migrate } from "./store.ts"
import { OUTREACH_THRESHOLD, SILENCE_MINUTES } from "./standing.ts"

const SWEEP_MINUTES = 15

await migrate()

let bot = createBot()

// ctx.me carries the bot's own username, which is how a group mention is
// recognised. Polling would populate it via start(); webhook mode never does.
if (bot) {
  try {
    await bot.init()
  } catch (err) {
    console.error("telegram init failed, disabling bot:", (err as Error)?.message)
    bot = undefined
  }
}

const webhook = bot && useWebhook()
const handleWebhook = bot && webhook ? webhookHandler(bot) : undefined

/**
 * Replaces the engine's per-conversation scheduled events with one periodic
 * sweep. A single query finds everyone who has gone quiet, which scales better
 * than a timer per petitioner and survives restarts without rearming anything.
 *
 * On a host that sleeps when idle this will rarely fire, since going quiet is
 * exactly what puts the service to sleep. That is a known cost of the free tier,
 * not a bug.
 */
const sweep = async () => {
  try {
    const ids = await dueForOutreach(OUTREACH_THRESHOLD, SILENCE_MINUTES)
    for (const id of ids) {
      try {
        const text = await reachOut(id)
        if (bot && id.startsWith("tg:")) {
          await bot.api.sendMessage(Number(id.slice(3)), text)
        }
        await markOutreach(id)
        console.log(`reached out to ${id}`)
      } catch (err) {
        console.error(`outreach failed for ${id}:`, (err as Error)?.message)
      }
    }
  } catch (err) {
    console.error("outreach sweep failed:", (err as Error)?.message)
  }
}

setInterval(sweep, SWEEP_MINUTES * 60_000)

const port = Number(process.env.PORT ?? 3000)

createServer((req, res) => {
  if (handleWebhook && req.method === "POST" && req.url === WEBHOOK_PATH) {
    handleWebhook(req, res).catch((err) => {
      console.error("webhook handler failed:", err?.message)
      if (!res.headersSent) res.writeHead(500).end()
    })
    return
  }

  if (req.url === PETITION_PATH) {
    handlePetition(req, res).catch((err) => {
      console.error("api handler failed:", err?.message)
      if (!res.headersSent) res.writeHead(500).end()
    })
    return
  }

  if (req.url?.split("?")[0] === PEOPLE_PATH) {
    handlePeople(req, res).catch((err) => {
      console.error("people handler failed:", err?.message)
      if (!res.headersSent) res.writeHead(500).end()
    })
    return
  }

  res.writeHead(200, { "content-type": "text/plain" })
  res.end("the order persists\n")
}).listen(port, async () => {
  console.log(`listening on ${port}`)
  if (!bot) return
  try {
    if (webhook) await registerWebhook(bot)
    else await startPolling(bot)
  } catch (err) {
    console.error("telegram startup failed:", (err as Error)?.message)
  }
})
