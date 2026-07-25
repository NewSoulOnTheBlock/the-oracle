import { Bot } from "grammy"
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

/** One petition in flight per chat. The Oracle does not talk over itself. */
const pending = new Set<number>()

export const startTelegram = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.log("no TELEGRAM_BOT_TOKEN — telegram disabled")
    return
  }

  const bot = new Bot(token)

  bot.command("about", (ctx) => ctx.reply(ABOUT))
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

  bot.start({ onStart: () => console.log("telegram: polling") })
  return bot
}
