import type { Call, Fetch } from './api.ts'
import type { Duration } from './duration.ts'
import type { Product, Text } from './products.ts'
import type { Payment, Store } from './store.ts'
import type { User } from './types.ts'

export interface Checkout<K extends string = string> {
  id: string
  user: User
  product: K
  data: string
  amount: number
}

export interface Paid extends Payment {
  renewal: boolean
  chat: number
}

export interface SubscriptionChange {
  user: User
  product: string
  data: string
  state: 'canceled' | 'active' | 'failed'
}

export interface Messages {
  unavailable: Text
  stale: Text
  owned: Text
  declined: Text
  failed: Text
}

type Answer = boolean | string | undefined

export interface Options<P extends Record<string, Product> = Record<string, Product>> {
  token: string
  products: P
  store?: Store
  check?: (q: Checkout<keyof P & string>) => Answer | Promise<Answer>
  onPaid?: (p: Paid) => unknown
  onRefund?: (p: Payment) => unknown
  onSubscription?: (s: SubscriptionChange) => unknown
  onError?: (e: unknown) => void
  terms?: Text
  support?: Text
  messages?: Partial<Messages>
  grace?: Duration
  timeout?: Duration
  now?: () => number
  fetch?: Fetch
  apiRoot?: string
  test?: boolean
}

export interface InvoiceOptions {
  data?: string
  title?: string
  description?: string
  photo?: string
  extra?: Record<string, unknown>
}

export interface Ctx {
  bot: number
  call: Call
  store: Store
  products: Record<string, Product>
  o: Options
  msg: Messages
  timeout: number
  now: () => number
  deliver(id: string, renewal: boolean, chat: number): Promise<void>
  notify(id: string): Promise<void>
}

export const text = (t: Text, u: User): string => (typeof t === 'function' ? t(u) : t)
