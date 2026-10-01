import { describe, expect, it } from 'vitest'
import type { SubscriptionChange } from '../src/index.ts'
import { DAY, setup } from './helpers.ts'

const user = { id: 42, is_bot: false, first_name: 'Dan' }

describe('subscriptions', () => {
  it('needs a link', async () => {
    const { stars } = setup()
    await expect(stars.send(42, 'pro')).rejects.toThrow('use link()')
  })

  it('renews every month and ends after the user cancels', async () => {
    const changes: SubscriptionChange[] = []
    const { tg, stars, paid } = setup({ onSubscription: (s) => void changes.push(s) })
    const { charge } = await tg.pay(42, await stars.link('pro'))
    expect(paid[0]).toMatchObject({ product: 'pro', renewal: false, until: tg.now() + 30 * DAY })
    expect(await stars.has(42, 'pro')).toBe(true)

    await tg.advance('30d')
    expect(paid).toHaveLength(2)
    expect(paid[1]).toMatchObject({ renewal: true, until: tg.now() + 30 * DAY })

    await tg.cancel(42, charge!)
    expect(changes).toEqual([
      { user: expect.objectContaining({ id: 42 }), product: 'pro', data: '', state: 'canceled' },
    ])
    expect((await stars.purchases(42)).at(-1)!.canceled).toBe('user')
    await tg.advance('30d')
    expect(paid).toHaveLength(2)
    expect(await stars.has(42, 'pro')).toBe(true)
    await tg.advance('59m')
    expect(await stars.has(42, 'pro')).toBe(true)
    await tg.advance('1m')
    expect(await stars.has(42, 'pro')).toBe(false)
  })

  it('ends right away without grace', async () => {
    const { tg, stars } = setup({ grace: 0 })
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.cancel(42, charge!)
    await tg.advance('30d')
    expect(await stars.has(42, 'pro')).toBe(false)
  })

  it('keeps renewing after the user turns renewal back on', async () => {
    const { tg, stars, paid } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.cancel(42, charge!)
    await tg.resume(42, charge!)
    expect((await stars.purchases(42))[0]!.canceled).toBeNull()
    await tg.advance('31d')
    expect(paid).toHaveLength(2)
    expect(await stars.has(42, 'pro')).toBe(true)
  })

  it('does not treat a failed renewal as a cancel', async () => {
    const changes: SubscriptionChange[] = []
    const { tg, stars } = setup({ onSubscription: (s) => void changes.push(s) })
    const { charge } = await tg.pay(42, await stars.link('pro'))
    tg.fail(42, charge!)
    await tg.advance('30d')
    expect(changes).toEqual([expect.objectContaining({ state: 'failed' })])
    expect((await stars.purchases(42))[0]!.canceled).toBeNull()
    await tg.advance('1h')
    expect(await stars.has(42, 'pro')).toBe(false)
  })

  it('does not sell a second subscription while one is active', async () => {
    const { tg, stars } = setup()
    await tg.pay(42, await stars.link('pro'))
    expect((await tg.pay(42, await stars.link('pro'))).error).toBe('You already have this.')
    await tg.advance('30d')
    expect((await tg.pay(42, await stars.link('pro'))).error).toBe('You already have this.')
  })

  it('sells a new subscription right after the old one ends, even inside grace', async () => {
    const { tg, stars } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.cancel(42, charge!)
    await tg.advance('30d')
    expect(await stars.has(42, 'pro')).toBe(true)
    expect((await tg.pay(42, await stars.link('pro'))).ok).toBe(true)
  })

  it('cancels and uncancels from the bot with the first charge id', async () => {
    const { tg, stars, paid } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.advance('30d')

    expect(await stars.uncancel(42, 'pro')).toBe(false)
    expect(await stars.cancel(42, 'pro')).toBe(true)
    expect(await stars.cancel(42, 'pro')).toBe(false)
    expect((await stars.purchases(42)).at(-1)!.canceled).toBe('bot')
    await expect(tg.resume(42, charge!)).rejects.toThrow('the bot canceled')

    expect(await stars.uncancel(42, 'pro')).toBe(true)
    expect(await stars.uncancel(42, 'pro')).toBe(false)
    expect((await stars.purchases(42)).at(-1)!.canceled).toBe('user')
    await tg.resume(42, charge!)
    await tg.advance('30d')
    expect(paid).toHaveLength(3)
    expect(await stars.cancel(42, 'pro')).toBe(true)
  })

  it('has nothing to cancel without an active subscription', async () => {
    const a = setup()
    expect(await a.stars.cancel(42, 'pro')).toBe(false)
    const { charge } = await a.tg.pay(42, await a.stars.link('pro'))
    await a.stars.refund(charge!)
    expect(await a.stars.cancel(42, 'pro')).toBe(false)

    const b = setup()
    await b.tg.pay(42, await b.stars.link('pro'))
    expect(await b.stars.cancel(42, 'pro')).toBe(true)
    await b.tg.advance('30d')
    expect(await b.stars.uncancel(42, 'pro')).toBe(false)
  })

  it('keeps track of the subscription when an update was missed', async () => {
    const { tg, stars, paid } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.cancel(42, charge!)
    tg.connect(() => {})
    await tg.resume(42, charge!)
    tg.connect(stars.handle)
    await tg.advance('30d')
    expect(paid.map((p) => p.renewal)).toEqual([false, true])
    expect((await stars.purchases(42)).map((p) => p.canceled)).toEqual([null, null])
    expect(await stars.cancel(42, 'pro')).toBe(true)
  })

  it('does not count a monthly payment without an end date', async () => {
    const { stars } = setup()
    const sp = {
      currency: 'XTR',
      total_amount: 250,
      invoice_payload: 'pro',
      telegram_payment_charge_id: 'c1',
      provider_payment_charge_id: '',
    }
    const chat = { id: 42, type: 'private' }
    await stars.handle({
      update_id: 1,
      message: { message_id: 1, chat, date: 0, successful_payment: sp },
    })
    expect(await stars.purchases(42)).toHaveLength(1)
    expect(await stars.has(42, 'pro')).toBe(false)
  })

  it('reports updates for subscriptions it does not know', async () => {
    const changes: SubscriptionChange[] = []
    const { stars } = setup({ onSubscription: (s) => void changes.push(s) })
    const subscription = { user, invoice_payload: 'pro', state: 'active' as const }
    expect(await stars.handle({ update_id: 1, subscription })).toBe(true)
    expect(changes).toEqual([{ user, product: 'pro', data: '', state: 'active' }])
    expect(await stars.purchases(42)).toEqual([])
  })
})
