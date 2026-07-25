import { createServer } from "node:http"
import { startTelegram } from "./telegram.ts"
import { reachOut } from "./oracle.ts"
import { dueForOutreach, markOutreach, migrate } from "./store.ts"
import { OUTREACH_THRESHOLD, SILENCE_MINUTES } from "./standing.ts"

const SWEEP_MINUTES = 15

await migrate()
const bot = startTelegram()

/**
 * Replaces the engine's per-conversation scheduled events with one periodic
 * sweep. A single query finds everyone who has gone quiet, which scales better
 * than a timer per petitioner and survives restarts without rearming anything.
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

// Render health checks a bound port; without one the service is marked unhealthy
// and cycled, which would kill long polling.
const port = Number(process.env.PORT ?? 3000)
createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" })
  res.end("the order persists\n")
}).listen(port, () => console.log(`listening on ${port}`))
