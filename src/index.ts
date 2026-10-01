import { api, TelegramError } from './api.ts'
import { toMs } from './duration.ts'
import { handler } from './handle.ts'
import type { Ctx, InvoiceOptions, Messages, Options } from './options.ts'
import {
  checkProducts,
  checkText,
  encode,
  MONTH,
  type Product,
  priceOf,
  TEST_MONTH,
} from './products.ts'
import { memory, type Payment } from './store.ts'
import { chain } from './subs.ts'
import { type SyncOptions, type SyncResult, syncer } from './sync.ts'
import type { Message } from './types.ts'

export type { Fetch } from './api.ts'
export type { Duration } from './duration.ts'
export type {
  Checkout,
  InvoiceOptions,
  Messages,
  Options,
  Paid,
  SubscriptionChange,
} from './options.ts'
export type { Product, Text } from './products.ts'
export type { Cursor, Payment, Store } from './store.ts'
export type { SyncOptions, SyncResult } from './sync.ts'
export type { Message, StarTransaction, Update, User } from './types.ts'
export { memory, TelegramError }

export interface Balance {
  stars: number
  nanostars: number
}

export type Middleware = (ctx: { update: unknown }, next: () => Promise<unknown>) => Promise<void>

export interface Stars<K extends string = string> {
  readonly bot: number
  send(chat: number | string, product: K, opts?: InvoiceOptions): Promise<Message>
  link(product: K, opts?: InvoiceOptions): Promise<string>
  handle(update: unknown): Promise<boolean>
  middleware(): Middleware
  has(user: number, product: K, data?: string): Promise<boolean>
  purchases(user: number): Promise<Payment[]>
  refund(id: string, user?: number): Promise<boolean>
  cancel(user: number, product: K, data?: string): Promise<boolean>
  uncancel(user: number, product: K, data?: string): Promise<boolean>
  balance(): Promise<Balance>
  sync(opts?: SyncOptions): Promise<SyncResult>
}

const LEASE = 3e5

const messages: Messages = {
  unavailable: 'Sorry, this is no longer available.',
  stale: 'The price has changed, please ask for a new invoice.',
  owned: 'You already have this.',
  declined: 'Sorry, this purchase is not available right now.',
  failed: 'Something went wrong, please try again in a moment.',
}

export const tgstars = <P extends Record<string, Product>>(
  o: Options<P>,
): Stars<keyof P & string> => {
  const bot = Number(/^(\d+):[\w-]+$/.exec(o.token)?.[1])
  if (!bot) throw new TypeError('tgstars: bad bot token')
  checkProducts(o.products)
  const timeout = toMs(o.timeout ?? '8s')
  if (!(timeout > 0 && timeout <= 9e3)) throw new RangeError('tgstars: timeout must be 1ms-9s')
  const grace = toMs(o.grace ?? '1h')
  const now = o.now ?? Date.now
  const store = o.store ?? memory()
  const call = api(o.token, o.fetch, o.apiRoot, o.test)
  const products: Record<string, Product> = o.products

  const live = (p: Payment) =>
    !p.refunded && (p.until === null ? !products[p.product]?.monthly : p.until + grace > now())

  const once = async (id: string, fn: (p: Payment) => Promise<unknown>) => {
    const t = now()
    if (!(await store.claim(bot, id, t, t + LEASE))) return
    try {
      await fn((await store.get(bot, id))!)
    } finally {
      await store.unclaim(bot, id)
    }
  }

  const c: Ctx = {
    bot,
    call,
    store,
    products,
    o: o as Options,
    msg: { ...messages, ...o.messages },
    timeout,
    now,
    deliver: (id, renewal, chat) =>
      once(id, async (p) => {
        if (p.delivered) return
        if (p.refunded) return store.patch(bot, id, { delivered: true, refundDelivered: true })
        await o.onPaid?.({ ...p, renewal, chat })
        await store.patch(bot, id, { delivered: true })
      }),
    notify: (id) =>
      once(id, async (p) => {
        if (!p.refunded || p.refundDelivered) return
        if (!p.delivered) return store.patch(bot, id, { delivered: true, refundDelivered: true })
        await o.onRefund?.(p)
        await store.patch(bot, id, { refundDelivered: true })
      }),
  }
  const handle = handler(c)

  const product = (key: string) => {
    if (!Object.hasOwn(products, key)) throw new TypeError(`tgstars: unknown product ${key}`)
    return products[key]!
  }

  const invoice = (key: string, p: Product, opts: InvoiceOptions) => {
    const data = opts.data ?? ''
    const title = opts.title ?? p.title
    const description = opts.description ?? p.description
    checkText(key, title, description)
    return {
      ...opts.extra,
      title,
      description,
      payload: encode(key, data),
      currency: 'XTR',
      prices: [{ label: title, amount: priceOf(key, p, data) }],
      photo_url: opts.photo ?? p.photo,
    }
  }

  const edit = async (user: number, key: string, data: string, cancel: boolean) => {
    const subs = chain(await store.list(bot, user), key, data)
    const last = subs.at(-1)
    if (!last || last.refunded || last.until! <= now()) return false
    if (cancel === (last.canceled === 'bot')) return false
    await call('editUserStarSubscription', {
      user_id: user,
      telegram_payment_charge_id: subs[0]!.id,
      is_canceled: cancel,
    })
    await store.patch(bot, last.id, { canceled: cancel ? 'bot' : 'user' })
    return true
  }

  return {
    bot,
    async send(chat, key, opts = {}) {
      const p = product(key)
      if (p.monthly) {
        throw new TypeError(
          `tgstars: ${key} is monthly and Telegram only sells subscriptions through links, use link()`,
        )
      }
      return call<Message>('sendInvoice', { ...invoice(key, p, opts), chat_id: chat })
    },
    async link(key, opts = {}) {
      const p = product(key)
      return call<string>('createInvoiceLink', {
        ...invoice(key, p, opts),
        ...(p.monthly && { subscription_period: o.test ? TEST_MONTH : MONTH }),
      })
    },
    handle,
    middleware: () => async (ctx, next) => {
      if (!(await handle(ctx.update))) await next()
    },
    async has(user, key, data) {
      return (await store.list(bot, user)).some(
        (p) => p.product === key && (data === undefined || p.data === data) && live(p),
      )
    },
    purchases: (user) => store.list(bot, user),
    async refund(id, user) {
      const p = await store.get(bot, id)
      if (p?.refunded) return false
      const uid = user ?? p?.user
      if (uid === undefined) throw new TypeError(`tgstars: unknown payment ${id}, pass the user id`)
      let fresh = true
      try {
        await call('refundStarPayment', { user_id: uid, telegram_payment_charge_id: id })
      } catch (e) {
        if (!(e instanceof TelegramError && e.description.includes('CHARGE_ALREADY_REFUNDED'))) {
          throw e
        }
        fresh = false
      }
      if (p) {
        await store.patch(bot, id, { refunded: true })
        await c.notify(id)
      }
      return fresh
    },
    cancel: (user, key, data = '') => edit(user, key, data, true),
    uncancel: (user, key, data = '') => edit(user, key, data, false),
    async balance() {
      const b = await call<{ amount: number; nanostar_amount?: number }>('getMyStarBalance')
      return { stars: b.amount, nanostars: b.nanostar_amount ?? 0 }
    },
    sync: syncer(c),
  }
}
