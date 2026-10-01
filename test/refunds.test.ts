import { describe, expect, it } from 'vitest'
import type { Update } from '../src/index.ts'
import { fake } from '../src/testing.ts'
import { refundElsewhere, START, setup, sleep } from './helpers.ts'

describe('refunds', () => {
  it('refunds once and calls onRefund once', async () => {
    const { tg, stars, refunds } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    expect(await stars.refund(charge!)).toBe(true)
    expect(await stars.refund(charge!)).toBe(false)
    expect(refunds).toEqual([expect.objectContaining({ id: charge, refunded: true })])
    expect(await stars.has(42, 'coffee')).toBe(false)
    expect(tg.balance).toBe(0)
  })

  it('calls onRefund once when refund() runs twice at the same time', async () => {
    const got: string[] = []
    const { tg, stars } = setup({
      onRefund: async (p) => {
        await sleep(20)
        got.push(p.id)
      },
    })
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    const res = await Promise.all([stars.refund(charge!), stars.refund(charge!)])
    expect(res.sort()).toEqual([false, true])
    expect(got).toEqual([charge])
  })

  it('handles refunds made outside tgstars', async () => {
    const { tg, stars, refunds } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await refundElsewhere(tg, 42, charge!)
    expect(refunds).toEqual([expect.objectContaining({ id: charge, refunded: true })])
    expect(await stars.refund(charge!)).toBe(false)
    expect(refunds).toHaveLength(1)
  })

  it('calls onRefund once when the same refund update is handled at the same time', async () => {
    const got: string[] = []
    const { tg, stars } = setup({
      onRefund: async (p) => {
        await sleep(20)
        got.push(p.id)
      },
    })
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    const updates: Update[] = []
    tg.connect((u) => void updates.push(u))
    await refundElsewhere(tg, 42, charge!)
    await Promise.all([stars.handle(updates[0]), stars.handle(updates[0])])
    expect(got).toEqual([charge])
  })

  it('records refunds for payments it never saw', async () => {
    const { tg, stars } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    const fresh = setup({}, tg)
    expect(await fresh.stars.refund(charge!, 42)).toBe(true)
    expect(await fresh.stars.purchases(42)).toEqual([
      expect.objectContaining({ id: charge, product: 'coffee', refunded: true }),
    ])
    expect(fresh.refunds).toHaveLength(1)
    expect(await stars.has(42, 'coffee')).toBe(true)
  })

  it('needs a user id for unknown payments', async () => {
    const { stars } = setup()
    await expect(stars.refund('nope')).rejects.toThrow(TypeError)
    await expect(stars.refund('nope', 42)).rejects.toThrow('CHARGE_ID_EMPTY')
  })

  it('treats a charge refunded elsewhere as done and still reports it', async () => {
    const { tg, stars, refunds } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    expect(await setup({}, tg).stars.refund(charge!, 42)).toBe(true)
    expect(refunds).toHaveLength(0)
    expect(await stars.refund(charge!)).toBe(false)
    expect(await stars.has(42, 'coffee')).toBe(false)
    expect(refunds).toEqual([expect.objectContaining({ id: charge })])
  })

  it('keeps the refund when the connection drops after Telegram refunded', async () => {
    const tg = fake({ now: START })
    const { stars, refunds } = setup(
      {
        fetch: async (url, init) => {
          const res = await tg.fetch(url, init)
          if (url.endsWith('/refundStarPayment')) throw new Error('connection reset')
          return res
        },
      },
      tg,
    )
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await expect(stars.refund(charge!)).rejects.toThrow('refundStarPayment request failed')
    expect(await stars.has(42, 'coffee')).toBe(false)
    expect(refunds).toHaveLength(1)
  })

  it('changes nothing when the refund never reached Telegram', async () => {
    const tg = fake({ now: START })
    const { stars, refunds } = setup(
      {
        fetch: (url, init) =>
          url.endsWith('/refundStarPayment')
            ? Promise.reject(new Error(`offline https://x/bot${encodeURIComponent(tg.token)}/`))
            : tg.fetch(url, init),
      },
      tg,
    )
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    const err = await stars.refund(charge!).catch((e: Error) => e)
    expect(String(err)).toContain('refundStarPayment request failed, offline')
    expect(String(err)).not.toContain('TEST-token')
    expect(await stars.has(42, 'coffee')).toBe(true)
    expect(refunds).toHaveLength(0)
  })

  it('drops a payment that was refunded before it was delivered', async () => {
    let fail = true
    const got: string[] = []
    const { tg, stars, refunds } = setup({
      onPaid: (p) => {
        if (fail) throw new Error('db down')
        got.push(p.id)
      },
    })
    await stars.sync()
    await expect(tg.pay(42, await stars.send(42, 'coffee'))).rejects.toThrow('db down')
    await refundElsewhere(tg, 42, tg.transactions.at(-1)!.id)
    fail = false
    await stars.sync()
    expect(got).toEqual([])
    expect(refunds).toEqual([])
    expect(await stars.purchases(42)).toEqual([
      expect.objectContaining({ refunded: true, delivered: true, refundDelivered: true }),
    ])
  })

  it('retries onRefund in sync after it threw', async () => {
    let fail = true
    const got: string[] = []
    const { tg, stars } = setup({
      onRefund: (p) => {
        if (fail) throw new Error('crm down')
        got.push(p.id)
      },
    })
    await stars.sync()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await expect(refundElsewhere(tg, 42, charge!)).rejects.toThrow('crm down')
    expect(await stars.has(42, 'coffee')).toBe(false)

    fail = false
    await stars.sync()
    await stars.sync()
    expect(got).toEqual([charge])
  })
})
