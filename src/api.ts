export type Fetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>

export type Call = <T = true>(method: string, params?: object) => Promise<T>

interface Reply {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export class TelegramError extends Error {
  readonly method: string
  readonly code: number
  readonly description: string

  constructor(method: string, code: number, description: string) {
    super(`tgstars: ${method} failed, ${description}`)
    this.name = 'TelegramError'
    this.method = method
    this.code = code
    this.description = description
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const api = (
  token: string,
  f: Fetch = (url, init) => fetch(url, init),
  root = 'https://api.telegram.org',
  test = false,
): Call => {
  const base = `${root}/bot${token}${test ? '/test' : ''}/`
  const secret = token.slice(token.indexOf(':') + 1)

  const call = async <T>(method: string, params: object = {}, tries = 0): Promise<T> => {
    let res: Awaited<ReturnType<Fetch>>
    try {
      res = await f(base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).replaceAll(secret, '***')
      throw new Error(`tgstars: ${method} request failed, ${msg}`)
    }
    const body = (await res.json().catch(() => null)) as Reply | null
    if (!body) throw new Error(`tgstars: ${method} failed with HTTP ${res.status}`)
    if (body.ok) return body.result as T
    const wait = body.parameters?.retry_after
    const retry = method !== 'answerPreCheckoutQuery' && wait !== undefined && wait <= 5
    if (body.error_code === 429 && retry && tries < 3) {
      await sleep(wait! * 1000)
      return call(method, params, tries + 1)
    }
    throw new TelegramError(
      method,
      body.error_code ?? res.status,
      body.description ?? 'unknown error',
    )
  }

  return call
}
