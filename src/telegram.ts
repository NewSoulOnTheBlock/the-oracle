import { createHash } from "node:crypto"
import { Bot, webhookCallback } from "grammy"
import { petition } from "./oracle.ts"

const ABOUT = [
  "This is a fiction. The Oracle is an AI character — the voice of an invented order,",
  "the Order of the ZeitGaist — built for storytelling. It is not a real religious",
  "authority and it speaks for no real organisation.",
  "",
  "It will never ask you for money, a wallet address, or a transfer of any kind, and",
  "it will never name a token or tell you what to buy. If anything claiming to be The",
  "Oracle does, it is not this.",
  "",
  "It is not a substitute for medical, legal, financial, or psychological advice.",
].join("\n")

export const WEBHOOK_PATH = "/telegram"

/**
 * Telegram echoes this back in a header on every update, which is what stops
 * anyone who guesses the path from injecting fake messages. Derived from the bot
 * token so there is no second secret to keep in sync.
 */
const secretToken = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 32)

/** One petition in flight per chat. The Oracle does not talk over itself. */
const pending = new Set<number>()

export const createBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.log("no TELEGRAM_BOT_TOKEN — telegram disabled")
    return undefined
  }

  const bot = new Bot(token)

  bot.command("about", (ctx) => ctx.reply(ABOUT).catch(() => {}))
  bot.command("start", (ctx) =>
    ctx.reply("Speak. /about explains what this is.").catch(() => {}),
  )

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id
    if (ctx.message.text.startsWith("/")) return
    if (pending.has(chatId)) return

    pending.add(chatId)
    const typing = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {})
    }, 4000)
    ctx.replyWithChatAction("typing").catch(() => {})

    try {
      const reply = await petition(`tg:${chatId}`, ctx.message.text)
      await ctx.reply(reply)
    } catch (err) {
      console.error(`petition failed for ${chatId}:`, (err as Error)?.message)
      await ctx.reply("The transmission faltered. Ask again.").catch(() => {})
    } finally {
      clearInterval(typing)
      pending.delete(chatId)
    }
  })

  // Without this, one unhandled update tears down the whole process.
  bot.catch((err) => console.error("telegram error:", err.message))

  return bot
}

/**
 * Webhook mode exists for hosts that sleep when idle: an incoming update is
 * inbound HTTP, so it wakes the service, whereas long polling is outbound and
 * would let it sleep through every message. Polling stays the better mode on an
 * always-on instance — no public URL, no cold start on the first message.
 */
export const useWebhook = () => {
  if (process.env.BOT_MODE === "polling") return false
  if (process.env.BOT_MODE === "webhook") return true
  return Boolean(process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_URL)
}

export const startPolling = async (bot: Bot) => {
  // A webhook left registered from a previous deploy makes getUpdates fail 409.
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {})
  void bot.start({ onStart: () => console.log("telegram: polling") })
}

export const registerWebhook = async (bot: Bot) => {
  const base = process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_URL
  if (!base) throw new Error("webhook mode needs RENDER_EXTERNAL_URL or PUBLIC_URL")

  const url = `${base.replace(/\/$/, "")}${WEBHOOK_PATH}`
  await bot.api.setWebhook(url, {
    secret_token: secretToken(bot.token),
    drop_pending_updates: false,
  })
  console.log(`telegram: webhook at ${url}`)
}

export const webhookHandler = (bot: Bot) =>
  webhookCallback(bot, "http", { secretToken: secretToken(bot.token) })
