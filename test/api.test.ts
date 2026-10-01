import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Fetch, TelegramError, tgstars } from '../src/index.ts'

const token = '123:abc-SECRET'
const products = {}
const limited = (retry_after: number) => ({
  ok: false,
  error_code: 429,
  description: 'Too Many Requests',
  parameters: { retry_after },
})
const balance = { ok: true, result: { amount: 1 } }

const replies = (...bodies: unknown[]) => {
  const urls: string[] = []
  const fetch: Fetch = async (url) => {
    urls.push(url)
    const body = bodies.length > 1 ? bodies.shift() : bodies[0]
    const ok = (body as { ok?: boolean }).ok
    return {
      status: ok ? 200 : 400,
      json: async () => (body instanceof Error ? Promise.reject(body) : body),
    }
  }
  return { fetch, urls }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('api', () => {
  it('reads the balance', async () => {
    const { fetch, urls } = replies({ ok: true, result: { amount: 12, nanostar_amount: 5 } })
    const stars = tgstars({ token, products, fetch, apiRoot: 'http://local', test: true })
    expect(await stars.balance()).toEqual({ stars: 12, nanostars: 5 })
    expect(urls).toEqual([`http://local/bot${token}/test/getMyStarBalance`])
  })

  it('uses the short subscription period in the test environment', async () => {
    const { fetch } = replies({ ok: true, result: 'https://t.me/$x' })
    const bodies: unknown[] = []
    const pro = { title: 'Pro', description: 'All', price: 5, monthly: true }
    const spy: Fetch = (url, init) => {
      bodies.push(JSON.parse(init.body))
      return fetch(url, init)
    }
    await tgstars({ token, products: { pro }, fetch: spy, test: true }).link('pro')
    await tgstars({ token, products: { pro }, fetch: spy }).link('pro')
    expect(bodies).toMatchObject([{ subscription_period: 300 }, { subscription_period: 2592000 }])
  })

  it('uses global fetch by default', async () => {
    const f = vi.fn(async () => ({
      status: 200,
      json: async () => ({ ok: true, result: { amount: 3 } }),
    }))
    vi.stubGlobal('fetch', f)
    expect(await tgstars({ token, products }).balance()).toEqual({ stars: 3, nanostars: 0 })
    expect(f).toHaveBeenCalledWith(`https://api.telegram.org/bot${token}/getMyStarBalance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  })

  it('waits as long as Telegram asks before retrying', async () => {
    vi.useFakeTimers()
    const { fetch, urls } = replies(limited(2), balance)
    const res = tgstars({ token, products, fetch }).balance()
    await vi.advanceTimersByTimeAsync(1999)
    expect(urls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await res).toEqual({ stars: 1, nanostars: 0 })
    expect(urls).toHaveLength(2)
  })

  it('gives up after three retries', async () => {
    const { fetch, urls } = replies(limited(0))
    const err = await tgstars({ token, products, fetch })
      .balance()
      .catch((e) => e)
    expect(err).toBeInstanceOf(TelegramError)
    expect(err).toMatchObject({ method: 'getMyStarBalance', code: 429 })
    expect(err.message).toBe('tgstars: getMyStarBalance failed, Too Many Requests')
    expect(urls).toHaveLength(4)
  })

  it('does not retry long waits or pre-checkout answers', async () => {
    const long = replies(limited(6), balance)
    await expect(tgstars({ token, products, fetch: long.fetch }).balance()).rejects.toThrow(
      'Too Many Requests',
    )
    expect(long.urls).toHaveLength(1)

    const pre = replies(limited(0), { ok: true, result: true })
    const stars = tgstars({
      token,
      products: { a: { title: 'A', description: 'B', price: 1 } },
      fetch: pre.fetch,
    })
    const from = { id: 1, is_bot: false, first_name: 'A' }
    const q = { id: 'q', from, currency: 'XTR', total_amount: 1, invoice_payload: 'a' }
    await expect(stars.handle({ update_id: 1, pre_checkout_query: q })).rejects.toThrow(
      'answerPreCheckoutQuery failed',
    )
    expect(pre.urls).toHaveLength(1)
  })

  it('explains broken responses', async () => {
    const html = replies(new SyntaxError('Unexpected token <'))
    await expect(tgstars({ token, products, fetch: html.fetch }).balance()).rejects.toThrow(
      'getMyStarBalance failed with HTTP 400',
    )
    const bare = replies({ ok: false })
    await expect(tgstars({ token, products, fetch: bare.fetch }).balance()).rejects.toMatchObject({
      code: 400,
      description: 'unknown error',
    })
  })

  it('keeps the token out of network errors', async () => {
    for (const leak of [token, encodeURIComponent(token)]) {
      const fetch: Fetch = () => Promise.reject(`connect ECONNREFUSED https://x/bot${leak}/`)
      const err = await tgstars({ token, products, fetch })
        .balance()
        .catch((e) => e)
      expect(err.message).toContain(
        'tgstars: getMyStarBalance request failed, connect ECONNREFUSED',
      )
      expect(err.message).not.toContain('SECRET')
    }
  })
})
