import { Bot } from 'grammy'
import { Telegraf } from 'telegraf'
import { describe, expect, it } from 'vitest'
import type { Update } from '../src/index.ts'
import { fake } from '../src/testing.ts'
import { START, setup } from './helpers.ts'

const user = { id: 42, is_bot: false, first_name: 'Dan' }
const text = (t: string, type = 'private'): Update => ({
  update_id: 1,
  message: { message_id: 1, from: user, chat: { id: 42, type }, date: 0, text: t },
})

describe('commands', () => {
  it('answers /terms and /paysupport', async () => {
    const { tg, stars } = setup({
      terms: 'Refunds within 7 days.',
      support: (u) => `Hi ${u.first_name}, write to @help`,
    })
    expect(await stars.handle(text('/terms'))).toBe(true)
    expect(await stars.handle(text('/paysupport@test_bot please'))).toBe(true)
    expect(tg.sent.map((m) => m.text)).toEqual(['Refunds within 7 days.', 'Hi Dan, write to @help'])
  })

  it('leaves other messages alone', async () => {
    const { tg, stars } = setup({ terms: 'Terms' })
    expect(await stars.handle(text('/paysupport'))).toBe(false)
    expect(await stars.handle(text('/termsx'))).toBe(false)
    expect(await stars.handle(text('/terms', 'group'))).toBe(false)
    expect(tg.sent).toHaveLength(0)
  })
})

describe('middleware', () => {
  it('works with grammY', async () => {
    const tg = fake({ now: START })
    const { stars, paid } = setup({ terms: 'Terms' }, tg)
    const bot = new Bot(tg.token, { client: { fetch: tg.fetch } })
    const seen: string[] = []
    bot.use(stars.middleware())
    bot.on('message:text', (ctx) => void seen.push(ctx.message.text))
    bot.on('message:successful_payment', () => void seen.push('payment'))
    bot.on('pre_checkout_query', () => void seen.push('checkout'))
    await bot.init()
    tg.connect((u) => bot.handleUpdate(u))

    await tg.pay(42, await stars.send(42, 'coffee'))
    await bot.handleUpdate(text('/terms') as never)
    await bot.handleUpdate(text('hello') as never)
    expect(paid).toHaveLength(1)
    expect(seen).toEqual(['hello'])
    expect(tg.sent.map((m) => m.text)).toEqual(['Terms'])
  })

  it('works with Telegraf', async () => {
    const tg = fake({ now: START })
    const { stars, paid } = setup({}, tg)
    const bot = new Telegraf(tg.token)
    bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' } as never
    const seen: string[] = []
    bot.use(stars.middleware())
    bot.on('text', (ctx) => void seen.push(ctx.message.text))
    bot.on('pre_checkout_query', () => void seen.push('checkout'))
    tg.connect((u) => bot.handleUpdate(u))

    await tg.pay(42, await stars.send(42, 'coffee'))
    await bot.handleUpdate(text('hello') as never)
    expect(paid).toHaveLength(1)
    expect(seen).toEqual(['hello'])
  })
})
