import { describe, expect, it } from 'vitest'
import type { Checkout } from '../src/index.ts'
import { products, setup } from './helpers.ts'

const user = { id: 42, is_bot: false, first_name: 'Dan', language_code: 'de' }
const declined = 'Sorry, this purchase is not available right now.'
const failed = 'Something went wrong, please try again in a moment.'

describe('checkout', () => {
  it('rejects stale prices', async () => {
    const { tg, stars } = setup()
    const inv = await stars.send(42, 'coffee')
    setup({ products: { ...products, coffee: { ...products.coffee, price: 50 } } }, tg)
    expect(await tg.pay(42, inv)).toEqual({
      ok: false,
      error: 'The price has changed, please ask for a new invoice.',
    })
  })

  it('rejects products that are gone', async () => {
    const { tg, stars } = setup({ products: { gone: products.coffee } })
    const url = await stars.link('gone')
    setup({}, tg)
    expect(await tg.pay(42, url)).toEqual({
      ok: false,
      error: 'Sorry, this is no longer available.',
    })
  })

  it('rejects data that breaks a dynamic price', async () => {
    const { tg, stars } = setup({ products: { pack: { ...products.pack, price: 10 } } })
    const url = await stars.link('pack', { data: 'lots' })
    setup({}, tg)
    expect((await tg.pay(42, url)).error).toBe('Sorry, this is no longer available.')
  })

  it('does not sell a once product twice', async () => {
    const { tg, stars } = setup()
    expect((await tg.pay(42, await stars.send(42, 'skin'))).ok).toBe(true)
    expect(await tg.pay(42, await stars.send(42, 'skin'))).toEqual({
      ok: false,
      error: 'You already have this.',
    })
    expect((await tg.pay(7, await stars.send(7, 'skin'))).ok).toBe(true)
  })

  it('sells a once product again after a refund', async () => {
    const { tg, stars } = setup()
    const { charge } = await tg.pay(42, await stars.send(42, 'skin'))
    await stars.refund(charge!)
    expect((await tg.pay(42, await stars.send(42, 'skin'))).ok).toBe(true)
  })

  it('passes the checkout to check and follows its answer', async () => {
    const seen: Checkout[] = []
    const answers: Record<string, boolean | string | undefined> = {
      1: false,
      2: '',
      3: 'Out of coins',
      4: true,
      5: undefined,
    }
    const { tg, stars } = setup({
      check: (q) => {
        seen.push(q)
        return answers[q.data]
      },
    })
    const pay = async (data: string) => tg.pay(user, await stars.send(42, 'pack', { data }))

    expect(await pay('1')).toEqual({ ok: false, error: declined })
    expect(await pay('2')).toEqual({ ok: false, error: declined })
    expect(await pay('3')).toEqual({ ok: false, error: 'Out of coins' })
    expect((await pay('4')).ok).toBe(true)
    expect((await pay('5')).ok).toBe(true)
    expect(seen[0]).toEqual({
      id: expect.any(String),
      user,
      product: 'pack',
      data: '1',
      amount: 10,
    })
  })

  it('answers no when check throws or is too slow', async () => {
    const errors: unknown[] = []
    const { tg, stars } = setup({
      timeout: 50,
      onError: (e) => void errors.push(e),
      check: (q) => {
        if (q.product === 'coffee') throw new Error('boom')
        return new Promise(() => {})
      },
    })
    expect((await tg.pay(42, await stars.send(42, 'coffee'))).error).toBe(failed)
    expect((await tg.pay(42, await stars.send(42, 'skin'))).error).toBe(failed)
    expect(String(errors[0])).toContain('boom')
    expect(String(errors[1])).toContain('check took longer than 50ms')
  })

  it('lets you translate messages', async () => {
    const { tg, stars } = setup({
      messages: { owned: (u) => (u.language_code === 'de' ? 'Hast du schon.' : 'Got it already.') },
    })
    await tg.pay(user, await stars.send(42, 'skin'))
    expect((await tg.pay(user, await stars.send(42, 'skin'))).error).toBe('Hast du schon.')
    await tg.pay(7, await stars.send(7, 'skin'))
    expect((await tg.pay(7, await stars.send(7, 'skin'))).error).toBe('Got it already.')
  })
})
