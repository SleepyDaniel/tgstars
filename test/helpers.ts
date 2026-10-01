import {
  type Options,
  type Paid,
  type Payment,
  type Product,
  type Stars,
  tgstars,
} from '../src/index.ts'
import { type Fake, fake } from '../src/testing.ts'
import type { Update } from '../src/types.ts'

type Keys = 'coffee' | 'skin' | 'pro' | 'pack'

export const products: Record<Keys, Product> = {
  coffee: { title: 'Coffee', description: 'Buy me a coffee', price: 25 },
  skin: { title: 'Gold skin', description: 'Shiny', price: 100, once: true },
  pro: { title: 'Pro', description: 'Everything unlocked', price: 250, monthly: true },
  pack: { title: 'Pack', description: 'Some coins', price: (qty) => 10 * Number(qty) },
}

export const DAY = 864e5
export const START: number = Date.UTC(2026, 0, 1)

export interface Setup<K extends string> {
  tg: Fake
  stars: Stars<K>
  paid: Paid[]
  refunds: Payment[]
  updates: Update[]
}

export const setup = <P extends Record<string, Product> = typeof products>(
  opts: Partial<Options<P>> = {},
  tg: Fake = fake({ now: START }),
): Setup<keyof P & string> => {
  const paid: Paid[] = []
  const refunds: Payment[] = []
  const updates: Update[] = []
  const stars = tgstars<P>({
    token: tg.token,
    fetch: tg.fetch,
    now: tg.now,
    products: products as unknown as P,
    onPaid: (p) => void paid.push(p),
    onRefund: (p) => void refunds.push(p),
    ...opts,
  })
  tg.connect(async (u) => {
    updates.push(u)
    await stars.handle(u)
  })
  return { tg, stars, paid, refunds, updates }
}

export interface Reply {
  ok: boolean
  result: string
  description?: string
}

export const post = async (
  tg: Fake,
  method: string,
  body: object,
  token: string = tg.token,
): Promise<Reply> => {
  const res = await tg.fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Reply
}

export const refundElsewhere = (tg: Fake, user: number, charge: string): Promise<Reply> =>
  post(tg, 'refundStarPayment', { user_id: user, telegram_payment_charge_id: charge })

export const down = (tg: Fake, stars: { handle(u: unknown): Promise<boolean> }): void =>
  tg.connect((u) => (u.pre_checkout_query ? stars.handle(u) : undefined))

export const sleep = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
