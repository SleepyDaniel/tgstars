import { describe, expect, it } from 'vitest'
import { fake } from '../src/testing.ts'
import { post, setup } from './helpers.ts'

const invoice = {
  title: 'A',
  description: 'B',
  payload: 'p',
  currency: 'XTR',
  prices: [{ label: 'A', amount: 5 }],
}
const bad = (description: string) => ({
  ok: false,
  error_code: 400,
  description: `Bad Request: ${description}`,
})

describe('fake', () => {
  it('checks the token and method', async () => {
    const tg = fake()
    expect(await post(tg, 'getMe', {}, '1:wrong')).toMatchObject({ error_code: 401 })
    expect(await post(tg, 'sendDice', {})).toMatchObject({ error_code: 404 })
    expect(await post(tg, 'getMe', {})).toMatchObject({ result: { id: 1234567, is_bot: true } })
    const odd = await tg.fetch(new Request('https://example.com/', { method: 'POST' }))
    expect(odd.status).toBe(401)
    const empty = await tg.fetch(`https://api.telegram.org/bot${tg.token}/getMe`)
    expect(empty.status).toBe(200)
    await expect(
      tg.fetch(`https://api.telegram.org/bot${tg.token}/getMe`, { method: 'POST', body: '{' }),
    ).rejects.toThrow(SyntaxError)
  })

  it('rejects invoices with the errors Telegram gives', async () => {
    const tg = fake({ bot: 99 })
    expect(tg.token).toMatch(/^99:/)
    const send = (p: object) => post(tg, 'sendInvoice', { ...invoice, ...p })
    const link = (p: object) => post(tg, 'createInvoiceLink', { ...invoice, ...p })
    const price = (amount: number) => ({ prices: [{ label: 'A', amount }] })
    expect(await post(tg, 'sendInvoice', {})).toEqual(bad('parameter "title" is required'))
    expect(await send({ description: '' })).toEqual(bad('parameter "description" is required'))
    expect(await send({ payload: '' })).toEqual(bad('parameter "payload" is required'))
    expect(await send({ currency: '' })).toEqual(bad('parameter "currency" is required'))
    expect(await send({ prices: undefined })).toEqual(bad('parameter "prices" is required'))
    expect(await send({ payload: 'x'.repeat(129) })).toEqual(bad('INVOICE_PAYLOAD_INVALID'))
    expect(await send({ currency: 'USD' })).toEqual(bad('PAYMENT_PROVIDER_INVALID'))
    expect(await send({ prices: [] })).toEqual(bad('there must be at least one price part'))
    expect(await send({ prices: [{ amount: 1 }, { amount: 1 }] })).toEqual(
      bad('STARS_INVOICE_INVALID'),
    )
    expect(await send(price(1.5))).toEqual(
      bad('can\'t parse LabeledPrice: Field "amount" must be a valid Number'),
    )
    expect(await send(price(0))).toEqual(bad('total price must be positive'))
    expect((await send({ title: 'x'.repeat(40), ...price(50000) })).ok).toBe(true)
    expect(await link({ subscription_period: 60 })).toEqual(bad('SUBSCRIPTION_PERIOD_INVALID'))
    expect(await link({ ...price(10001), subscription_period: 2592000 })).toEqual(
      bad('SUBSCRIPTION_AMOUNT_INVALID'),
    )
  })

  it('ignores subscription_period in sendInvoice, like the Bot API', async () => {
    const tg = fake()
    tg.connect((u) =>
      u.pre_checkout_query
        ? post(tg, 'answerPreCheckoutQuery', {
            pre_checkout_query_id: u.pre_checkout_query.id,
            ok: true,
          })
        : undefined,
    )
    const msg = await post(tg, 'sendInvoice', {
      ...invoice,
      chat_id: 1,
      subscription_period: 2592000,
    })
    await tg.pay(1, msg.result as never)
    expect(tg.transactions[0]!.source).not.toHaveProperty('subscription_period')
  })

  it('answers pre-checkout queries once', async () => {
    const tg = fake()
    const results: unknown[] = []
    tg.connect(async (u) => {
      if (!u.pre_checkout_query) return
      const id = u.pre_checkout_query.id
      results.push(
        await post(tg, 'answerPreCheckoutQuery', { pre_checkout_query_id: id, ok: false }),
      )
      results.push(
        await post(tg, 'answerPreCheckoutQuery', { pre_checkout_query_id: id, ok: true }),
      )
      results.push(
        await post(tg, 'answerPreCheckoutQuery', { pre_checkout_query_id: id, ok: true }),
      )
    })
    const url = (await post(tg, 'createInvoiceLink', invoice)).result
    expect(await tg.pay(1, url)).toEqual({ ok: true, charge: expect.any(String) })
    expect(results).toEqual([
      bad('parameter "error_message" is required'),
      { ok: true, result: true },
      bad('query is too old and response timeout expired or query ID is invalid'),
    ])
  })

  it('cancels payments nobody answered', async () => {
    const tg = fake()
    await expect(tg.pay(1, 'https://t.me/$nope')).rejects.toThrow('unknown invoice')
    const url = (await post(tg, 'createInvoiceLink', invoice)).result
    await expect(tg.pay(1, url)).rejects.toThrow('call connect() first')
    tg.connect(() => {})
    expect(await tg.pay(1, url)).toEqual({ ok: false, error: 'no answer' })
    expect(tg.transactions).toHaveLength(0)
  })

  it('checks subscription edits', async () => {
    const { tg, stars } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.advance('30d')
    const renewal = tg.transactions.at(-1)!.id
    const edit = { user_id: 42, telegram_payment_charge_id: charge, is_canceled: true }
    expect(await post(tg, 'editUserStarSubscription', { ...edit, user_id: 7 })).toEqual(
      bad('CHARGE_ID_INVALID'),
    )
    expect(
      await post(tg, 'editUserStarSubscription', { ...edit, telegram_payment_charge_id: renewal }),
    ).toMatchObject({ ok: true })
    expect(await post(tg, 'editUserStarSubscription', edit)).toMatchObject({ ok: true })
    await tg.advance('31d')
    expect(await post(tg, 'editUserStarSubscription', edit)).toEqual(bad('SUBSCRIPTION_NOT_ACTIVE'))
    await expect(tg.cancel(42, charge!)).rejects.toThrow('this subscription has ended')
    expect(() => tg.fail(7, charge!)).toThrow('CHARGE_ID_INVALID')
  })

  it('never moves the clock back', async () => {
    const { tg, stars } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.cancel(42, charge!)
    await tg.advance('90d')
    const before = tg.now()
    await expect(tg.resume(42, charge!)).rejects.toThrow('this subscription has ended')
    await tg.advance('1d')
    expect(tg.now()).toBe(before + 864e5)
    expect(tg.transactions).toHaveLength(1)
  })

  it('renews subscriptions in the order they are due', async () => {
    const { tg, stars, paid } = setup()
    await tg.pay(1, await stars.link('pro'))
    await tg.advance('1d')
    await tg.pay(2, await stars.link('pro'))
    await tg.advance('60d')
    expect(paid.map((p) => p.user)).toEqual([1, 2, 1, 2, 1, 2])
    expect(tg.balance).toBe(1500)
  })

  it('lists transactions and the balance', async () => {
    const { tg, stars } = setup()
    await tg.pay(42, await stars.send(42, 'coffee'))
    expect(await post(tg, 'getStarTransactions', {})).toMatchObject({
      result: {
        transactions: [{ amount: 25, source: { type: 'user', invoice_payload: 'coffee' } }],
      },
    })
    expect(await post(tg, 'getMyStarBalance', {})).toEqual({ ok: true, result: { amount: 25 } })
  })
})
