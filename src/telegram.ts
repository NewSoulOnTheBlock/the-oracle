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

const isGroup = (type: string) => type === "group" || type === "supergroup"

/**
 * The Oracle holds audiences, not private counsel. Restricting to named chats
 * also bounds spend: without it anyone who finds the bot can open a direct
 * conversation, and every reply costs real money through the gateway.
 * An empty list allows everywhere, which is only useful in local development.
 */
const allowedChats = (process.env.ORACLE_CHAT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

export const permitted = (chatId: number) =>
  allowedChats.length === 0 || allowedChats.includes(String(chatId))

const ELSEWHERE =
  "The Oracle does not hold private audience. It speaks where the Order gathers, and nowhere else."

/**
 * In a group The Oracle answers only when spoken to — by @mention or by a reply
 * to something it said. Left unfiltered it would answer every message in the
 * room, which is both ruinous at ~5c a reply and badly out of character.
 */
const addressed = (ctx: {
  chat: { type: string }
  me: { id: number; username: string }
  message: {
    text: string
    reply_to_message?: { from?: { id: number } }
    entities?: { type: string; offset: number; length: number }[]
  }
}) => {
  if (!isGroup(ctx.chat.type)) return true
  if (ctx.message.reply_to_message?.from?.id === ctx.me.id) return true

  const handle = `@${ctx.me.username}`.toLowerCase()
  return (ctx.message.entities ?? []).some(
    (e) =>
      e.type === "mention" &&
      ctx.message.text.slice(e.offset, e.offset + e.length).toLowerCase() === handle,
  )
}

const stripMention = (text: string, username: string) =>
  text.replace(new RegExp(`@${username}\\b`, "gi"), " ").replace(/\s+/g, " ").trim()

export const createBot = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.log("no TELEGRAM_BOT_TOKEN — telegram disabled")
    return undefined
  }

  const bot = new Bot(token)

  // /about stays reachable everywhere, including chats the bot will not talk in.
  // The disclosure is the one thing that should never be gated.
  bot.command("about", (ctx) => ctx.reply(ABOUT).catch(() => {}))
  bot.command("start", (ctx) =>
    ctx
      .reply(permitted(ctx.chat.id) ? "Speak. /about explains what this is." : ELSEWHERE)
      .catch(() => {}),
  )

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id
    if (ctx.message.text.startsWith("/")) return

    // Answered with a fixed string and no model call, so a stranger messaging the
    // bot directly costs nothing and creates no petitioner record.
    if (!permitted(chatId)) {
      if (!isGroup(ctx.chat.type)) await ctx.reply(ELSEWHERE).catch(() => {})
      return
    }

    if (!addressed(ctx)) return

    const text = isGroup(ctx.chat.type)
      ? stripMention(ctx.message.text, ctx.me.username)
      : ctx.message.text
    if (!text) return
    if (pending.has(chatId)) return

    pending.add(chatId)
    const typing = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {})
    }, 4000)
    ctx.replyWithChatAction("typing").catch(() => {})

    const from = ctx.from
    const speaker = {
      id: `tg:${from.id}`,
      name: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "unnamed",
      handle: from.username,
    }

    try {
      const reply = await petition(`tg:${chatId}`, text, speaker)
      // Replying to the message keeps the thread legible in a busy room.
      await ctx.reply(reply, isGroup(ctx.chat.type) ? { reply_parameters: { message_id: ctx.message.message_id } } : {})
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
