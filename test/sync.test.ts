import { describe, expect, it } from 'vitest'
import { memory } from '../src/index.ts'
import { fake } from '../src/testing.ts'
import { down, refundElsewhere, START, setup, sleep } from './helpers.ts'

describe('sync', () => {
  it('rebuilds purchases without delivering them the first time', async () => {
    const { tg, stars } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await tg.pay(7, await stars.link('pro'))
    await stars.refund(charge!)

    const fresh = setup({}, tg)
    expect(await fresh.stars.sync()).toEqual({ payments: 2, refunds: 1 })
    expect(fresh.paid).toHaveLength(0)
    expect(fresh.refunds).toHaveLength(0)
    expect(await fresh.stars.has(42, 'coffee')).toBe(false)
    expect(await fresh.stars.has(7, 'pro')).toBe(true)
    expect((await fresh.stars.purchases(7))[0]).toMatchObject({ product: 'pro', delivered: true })
  })

  it('delivers payments and refunds it missed', async () => {
    const { tg, stars, paid, refunds } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await stars.sync()

    down(tg, stars)
    await tg.pay(7, await stars.send(7, 'coffee'))
    await refundElsewhere(tg, 42, charge!)
    expect(paid).toHaveLength(1)
    expect(refunds).toHaveLength(0)

    expect(await stars.sync()).toEqual({ payments: 1, refunds: 1 })
    expect(paid.map((p) => p.user)).toEqual([42, 7])
    expect(paid[1]).toMatchObject({ renewal: false, chat: 7 })
    expect(refunds).toEqual([expect.objectContaining({ id: charge })])
    expect(await stars.sync()).toEqual({ payments: 0, refunds: 0 })
    expect(paid).toHaveLength(2)
    expect(refunds).toHaveLength(1)
  })

  it('delivers the first payments of a brand new bot', async () => {
    const store = memory()
    const { tg, stars } = setup({ store })
    await stars.sync()
    expect(await store.cursor(stars.bot)).toEqual({ offset: 0, last: '', ready: true })

    down(tg, stars)
    await tg.pay(42, await stars.send(42, 'coffee'))
    const after = setup({ store }, tg)
    await after.stars.sync()
    expect(after.paid.map((p) => p.user)).toEqual([42])
  })

  it('does not deliver old history when the first sync was cut short', async () => {
    const tg = fake({ now: START })
    const { stars } = setup({}, tg)
    for (let i = 1; i <= 150; i++) await tg.pay(i, await stars.send(i, 'coffee'))

    const store = memory()
    let calls = 0
    const flaky = setup(
      {
        store,
        fetch: (url, init) =>
          url.endsWith('/getStarTransactions') && ++calls === 2
            ? Promise.reject(new Error('timeout'))
            : tg.fetch(url, init),
      },
      tg,
    )
    await expect(flaky.stars.sync()).rejects.toThrow('timeout')
    expect(await store.cursor(flaky.stars.bot)).toMatchObject({ offset: 100, ready: false })
    expect(await flaky.stars.sync()).toEqual({ payments: 50, refunds: 0 })
    expect(flaky.paid).toHaveLength(0)

    down(tg, flaky.stars)
    await tg.pay(500, await stars.send(500, 'coffee'))
    await flaky.stars.sync()
    expect(flaky.paid.map((p) => p.user)).toEqual([500])
  })

  it('marks missed renewals as renewals', async () => {
    const { tg, stars, paid } = setup()
    await tg.pay(42, await stars.link('pro'))
    await stars.sync()
    down(tg, stars)
    await tg.advance('30d')
    await stars.sync()
    expect(paid.map((p) => p.renewal)).toEqual([false, true])
    expect(await stars.has(42, 'pro')).toBe(true)
  })

  it('does not call a new subscription a renewal', async () => {
    const { tg, stars, paid } = setup()
    const { charge } = await tg.pay(42, await stars.link('pro'))
    await tg.cancel(42, charge!)
    await stars.sync()
    await tg.advance('30d')
    down(tg, stars)
    await tg.pay(42, await stars.link('pro'))
    await stars.sync()
    expect(paid.map((p) => p.renewal)).toEqual([false, false])
  })

  it('reads only new transactions', async () => {
    const tg = fake({ now: START })
    const offsets: number[] = []
    const { stars } = setup(
      {
        fetch: async (url, init) => {
          if (url.endsWith('/getStarTransactions'))
            offsets.push(JSON.parse(String(init.body)).offset)
          return tg.fetch(url, init)
        },
      },
      tg,
    )
    for (let i = 1; i <= 230; i++) await tg.pay(i, await stars.send(i, 'coffee'))
    expect(await stars.sync()).toEqual({ payments: 0, refunds: 0 })
    expect(offsets).toEqual([0, 100, 200])
    offsets.length = 0
    await tg.pay(1000, await stars.send(1000, 'coffee'))
    await stars.sync()
    expect(offsets).toEqual([229, 230])
  })

  it('starts over when the history does not match', async () => {
    const store = memory()
    const { tg, stars } = setup({ store })
    await tg.pay(42, await stars.send(42, 'coffee'))
    await tg.pay(43, await stars.send(43, 'coffee'))
    await store.setCursor(stars.bot, { offset: 1, last: 'bogus', ready: true })
    expect(await stars.sync()).toEqual({ payments: 0, refunds: 0 })
    expect(await store.cursor(stars.bot)).toMatchObject({ offset: 2 })

    await store.setCursor(stars.bot, { offset: 10, last: 'bogus', ready: true })
    expect(await stars.sync()).toEqual({ payments: 0, refunds: 0 })
    expect(await store.cursor(stars.bot)).toMatchObject({ offset: 2 })
  })

  it('can be told whether to deliver', async () => {
    const { tg, stars } = setup()
    const a = await tg.pay(42, await stars.send(42, 'coffee'))
    await tg.pay(43, await stars.send(43, 'coffee'))
    await stars.refund(a.charge!)

    const fresh = setup({}, tg)
    await fresh.stars.sync({ deliver: true })
    expect(fresh.paid.map((p) => p.user)).toEqual([43])
    expect(fresh.refunds).toHaveLength(0)

    down(tg, fresh.stars)
    await tg.pay(44, await stars.send(44, 'coffee'))
    expect(await fresh.stars.sync({ deliver: false })).toEqual({ payments: 1, refunds: 0 })
    expect(fresh.paid).toHaveLength(1)
  })

  it('skips payments that were refunded before anyone delivered them', async () => {
    const { tg, stars, paid, refunds } = setup()
    await stars.sync()
    down(tg, stars)
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await refundElsewhere(tg, 42, charge!)
    expect(await stars.sync()).toEqual({ payments: 1, refunds: 1 })
    expect(paid).toHaveLength(0)
    expect(refunds).toHaveLength(0)
    expect(await stars.has(42, 'coffee')).toBe(false)
  })

  it('keeps delivering when one payment fails', async () => {
    const { tg, stars } = setup()
    const got: number[] = []
    const picky = setup(
      {
        onPaid: (p) => {
          if (p.user === 1) throw new Error('user 1 is broken')
          got.push(p.user)
        },
      },
      tg,
    )
    await picky.stars.sync()
    down(tg, picky.stars)
    for (const u of [1, 2, 3]) await tg.pay(u, await stars.send(u, 'coffee'))
    const err = await picky.stars.sync().catch((e) => e)
    expect(err).toBeInstanceOf(AggregateError)
    expect(err.message).toBe('tgstars: 1 deliveries failed in sync')
    expect(got).toEqual([2, 3])
  })

  it('delivers once when sync overlaps a webhook or another sync', async () => {
    const got: string[] = []
    const { tg, stars, updates } = setup({
      onPaid: async (p) => {
        await sleep(20)
        got.push(p.id)
      },
    })
    await stars.sync()
    tg.connect((u) => (u.pre_checkout_query ? stars.handle(u) : void updates.push(u)))
    await tg.pay(42, await stars.send(42, 'coffee'))
    await tg.pay(43, await stars.send(43, 'coffee'))
    const hook = updates.filter((u) => u.message?.successful_payment)
    const ids = hook.map((u) => u.message!.successful_payment!.telegram_payment_charge_id)
    await Promise.all([stars.handle(hook[0]), stars.sync(), stars.sync(), stars.handle(hook[1])])
    expect(got.sort()).toEqual(ids.sort())
  })

  it('retries a delivery that crashed once its lease runs out', async () => {
    let crash = true
    const got: string[] = []
    const { tg, stars } = setup({
      store: { ...memory(), unclaim: async () => {} },
      onPaid: (p) => {
        if (crash) {
          crash = false
          throw new Error('process died')
        }
        got.push(p.id)
      },
    })
    await stars.sync()
    await expect(tg.pay(42, await stars.send(42, 'coffee'))).rejects.toThrow('process died')
    await stars.sync()
    await tg.advance('4m')
    await stars.sync()
    expect(got).toHaveLength(0)
    await tg.advance('1m')
    await stars.sync()
    expect(got).toHaveLength(1)
  })

  it('skips transactions that are not invoice payments', async () => {
    const { tg, stars } = setup()
    const date = tg.now() / 1000
    const user = { id: 1, is_bot: false, first_name: 'A' }
    const other = (id: string, extra: object) => ({ id, amount: 5, date, ...extra })
    tg.transactions.push(
      other('w1', { receiver: { type: 'fragment' } }),
      other('g1', { receiver: { type: 'user', transaction_type: 'gift_purchase', user } }),
      other('m1', { source: { type: 'user', transaction_type: 'paid_media_payment', user } }),
      other('p1', { source: { type: 'user', transaction_type: 'invoice_payment', user } }),
      other('a1', { source: { type: 'affiliate_program' } }),
    )
    expect(await stars.sync()).toEqual({ payments: 1, refunds: 0 })
    expect(await stars.purchases(1)).toEqual([expect.objectContaining({ id: 'p1', product: '' })])
  })
})
