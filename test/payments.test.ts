import { describe, expect, it } from 'vitest'
import { setup, sleep } from './helpers.ts'

const user = { id: 42, is_bot: false, first_name: 'Dan' }

describe('payments', () => {
  it('sends an invoice and delivers the payment once', async () => {
    const { tg, stars, paid } = setup()
    const inv = await stars.send(42, 'coffee')
    expect(inv.invoice).toMatchObject({ title: 'Coffee', currency: 'XTR', total_amount: 25 })

    const res = await tg.pay(42, inv)
    expect(res.ok).toBe(true)
    expect(paid).toEqual([
      expect.objectContaining({
        id: res.charge,
        user: 42,
        product: 'coffee',
        data: '',
        amount: 25,
        until: null,
        renewal: false,
        chat: 42,
      }),
    ])
    expect(tg.balance).toBe(25)
    expect(await stars.has(42, 'coffee')).toBe(true)
    expect(await stars.has(7, 'coffee')).toBe(false)
    expect((await stars.purchases(42))[0]).toMatchObject({ delivered: true, refunded: false })
  })

  it('does not deliver twice when Telegram redelivers the update', async () => {
    const { tg, stars, paid, updates } = setup()
    await tg.pay(42, await stars.send(42, 'coffee'))
    const payment = updates.find((u) => u.message?.successful_payment)!
    expect(await stars.handle(payment)).toBe(true)
    expect(await stars.handle(payment)).toBe(true)
    expect(paid).toHaveLength(1)
  })

  it('does not deliver twice when the same update is handled at the same time', async () => {
    const got: string[] = []
    const { tg, stars, updates } = setup({
      onPaid: async (p) => {
        await sleep(20)
        got.push(p.id)
      },
    })
    const inv = await stars.send(42, 'coffee')
    tg.connect((u) => (u.pre_checkout_query ? stars.handle(u) : void updates.push(u)))
    await tg.pay(42, inv)
    const payment = updates.find((u) => u.message?.successful_payment)!
    await Promise.all([stars.handle(payment), stars.handle(payment), stars.handle(payment)])
    expect(got).toHaveLength(1)
  })

  it('retries delivery when onPaid threw', async () => {
    let fail = true
    const got: string[] = []
    const { tg, stars, updates } = setup({
      onPaid: (p) => {
        if (fail) throw new Error('db down')
        got.push(p.id)
      },
    })
    await expect(tg.pay(42, await stars.send(42, 'coffee'))).rejects.toThrow('db down')
    expect((await stars.purchases(42))[0]!.delivered).toBe(false)

    fail = false
    const payment = updates.find((u) => u.message?.successful_payment)!
    await stars.handle(payment)
    await stars.handle(payment)
    expect(got).toHaveLength(1)
    expect((await stars.purchases(42))[0]!.delivered).toBe(true)
  })

  it('carries custom data and dynamic prices', async () => {
    const { tg, stars, paid } = setup()
    const inv = await stars.send(42, 'pack', { data: '3', title: '3 coins' })
    expect(inv.invoice).toMatchObject({ title: '3 coins', total_amount: 30 })
    await tg.pay(42, inv)
    expect(paid[0]).toMatchObject({ product: 'pack', data: '3', amount: 30 })
    expect(await stars.has(42, 'pack', '3')).toBe(true)
    expect(await stars.has(42, 'pack', '4')).toBe(false)
    expect(await stars.has(42, 'pack')).toBe(true)
  })

  it('keeps repeatable products owned', async () => {
    const { tg, stars } = setup()
    await tg.pay(42, await stars.send(42, 'coffee'))
    await tg.advance('3650d')
    expect(await stars.has(42, 'coffee')).toBe(true)
  })

  it('lets extra add fields but not change the invoice', async () => {
    const { tg, stars, paid } = setup()
    const extra = { payload: 'skin', prices: [{ label: 'x', amount: 1 }], chat_id: 7 }
    const inv = await stars.send(42, 'coffee', { extra })
    expect(inv.chat.id).toBe(42)
    expect(inv.invoice!.total_amount).toBe(25)
    await tg.pay(42, inv)
    expect(paid[0]).toMatchObject({ product: 'coffee', amount: 25 })
  })

  it('works with invoice links', async () => {
    const { tg, stars, paid } = setup()
    const url = await stars.link('coffee', { photo: 'https://example.com/c.png' })
    expect(url).toMatch(/^https:\/\/t\.me\//)
    expect((await tg.pay(user, url)).ok).toBe(true)
    expect(paid).toHaveLength(1)
  })

  it('ignores updates that are not Stars payments', async () => {
    const { stars } = setup()
    const chat = { id: 42, type: 'private' }
    const usd = { currency: 'USD', total_amount: 100, invoice_payload: 'x' }
    const pre_checkout_query = { id: 'q', from: user, ...usd }
    expect(await stars.handle({ update_id: 1, pre_checkout_query })).toBe(false)
    const sp = { ...usd, telegram_payment_charge_id: 'c', provider_payment_charge_id: 'p' }
    const message = { message_id: 1, chat, date: 0, from: user }
    expect(
      await stars.handle({ update_id: 2, message: { ...message, successful_payment: sp } }),
    ).toBe(false)
    expect(
      await stars.handle({ update_id: 3, message: { ...message, refunded_payment: sp } }),
    ).toBe(false)
    expect(await stars.handle({ update_id: 4, message: { ...message, text: 'hi' } })).toBe(false)
    expect(await stars.handle({ update_id: 5, callback_query: {} })).toBe(false)
    expect(await stars.handle(null)).toBe(false)
    expect(await stars.purchases(42)).toEqual([])
  })

  it('falls back to the chat id when a service message has no sender', async () => {
    const { stars, paid, refunds } = setup()
    const chat = { id: 42, type: 'private' }
    const pay = { currency: 'XTR', total_amount: 25, invoice_payload: 'coffee' }
    const ids = { telegram_payment_charge_id: 'c1', provider_payment_charge_id: '' }
    await stars.handle({
      update_id: 1,
      message: { message_id: 1, chat, date: 0, successful_payment: { ...pay, ...ids } },
    })
    await stars.handle({
      update_id: 2,
      message: { message_id: 2, chat, date: 0, refunded_payment: { ...pay, ...ids } },
    })
    expect(paid[0]).toMatchObject({ id: 'c1', user: 42, chat: 42 })
    expect(refunds[0]).toMatchObject({ id: 'c1', user: 42 })
  })
})
