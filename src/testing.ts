import { type Duration, toMs } from './duration.ts'
import { MONTH } from './products.ts'
import type { Message, StarTransaction, Update, User } from './types.ts'

export interface FakeOptions {
  bot?: number
  now?: number
}

export interface PayResult {
  ok: boolean
  charge?: string
  error?: string
}

export interface Fake {
  readonly token: string
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly balance: number
  readonly transactions: StarTransaction[]
  readonly sent: Message[]
  connect(handler: (update: any) => unknown): void
  pay(user: number | User, invoice: Message | string): Promise<PayResult>
  cancel(user: number, charge: string): Promise<void>
  resume(user: number, charge: string): Promise<void>
  fail(user: number, charge: string): void
  advance(time: Duration): Promise<void>
}

interface Invoice {
  title: string
  description: string
  payload: string
  amount: number
  period: number
}

interface Sub {
  user: User
  payload: string
  amount: number
  charges: string[]
  until: number
  renew: boolean
  botCanceled: boolean
  failing: boolean
}

class BadRequest extends Error {}

const sec = (ms: number) => Math.floor(ms / 1000)

export const fake = ({ bot = 1234567, now: start = Date.now() }: FakeOptions = {}): Fake => {
  const token = `${bot}:TEST-token`
  let t = start
  let n = 0
  let balance = 0
  let handler: ((u: Update) => unknown) | undefined
  const invoices = new Map<string, Invoice>()
  const answers = new Map<string, { ok: boolean; error_message?: string } | null>()
  const charges = new Map<
    string,
    { user: number; amount: number; payload: string; refunded: boolean }
  >()
  const subs: Sub[] = []
  const transactions: StarTransaction[] = []
  const sent: Message[] = []

  const toUser = (u: number | User): User =>
    typeof u === 'number' ? { id: u, is_bot: false, first_name: `User ${u}` } : u

  const emit = async (u: Omit<Update, 'update_id'>) => {
    if (!handler) throw new Error('tgstars/testing: call connect() first')
    await handler({ update_id: ++n, ...u })
  }

  const message = (chat: number, extra: Partial<Message>): Message => ({
    message_id: ++n,
    chat: { id: chat, type: 'private' },
    date: sec(t),
    ...extra,
  })

  const invoice = (p: Record<string, unknown>): Invoice => {
    for (const k of ['title', 'description', 'payload', 'currency', 'prices']) {
      if (!p[k]) throw new BadRequest(`parameter "${k}" is required`)
    }
    const payload = String(p.payload)
    if (new TextEncoder().encode(payload).length > 128) {
      throw new BadRequest('INVOICE_PAYLOAD_INVALID')
    }
    if (p.currency !== 'XTR') throw new BadRequest('PAYMENT_PROVIDER_INVALID')
    const prices = p.prices as { amount: number }[]
    if (!prices.length) throw new BadRequest('there must be at least one price part')
    if (prices.length > 1) throw new BadRequest('STARS_INVOICE_INVALID')
    const amount = prices[0]!.amount
    if (!Number.isInteger(amount)) {
      throw new BadRequest('can\'t parse LabeledPrice: Field "amount" must be a valid Number')
    }
    if (amount <= 0) throw new BadRequest('total price must be positive')
    const period = Number(p.subscription_period ?? 0)
    if (period && period !== MONTH) throw new BadRequest('SUBSCRIPTION_PERIOD_INVALID')
    if (period && amount > 10000) throw new BadRequest('SUBSCRIPTION_AMOUNT_INVALID')
    return { title: String(p.title), description: String(p.description), payload, amount, period }
  }

  const charge = (u: User, amount: number, payload: string, period: number) => {
    const id = `stxTEST${++n}`
    charges.set(id, { user: u.id, amount, payload, refunded: false })
    balance += amount
    transactions.push({
      id,
      amount,
      date: sec(t),
      source: {
        type: 'user',
        transaction_type: 'invoice_payment',
        user: u,
        invoice_payload: payload,
        ...(period && { subscription_period: period }),
      },
    })
    return id
  }

  const paid = (u: User, id: string, amount: number, payload: string, extra = {}) =>
    emit({
      message: message(u.id, {
        from: u,
        successful_payment: {
          currency: 'XTR',
          total_amount: amount,
          invoice_payload: payload,
          telegram_payment_charge_id: id,
          provider_payment_charge_id: '',
          ...extra,
        },
      }),
    })

  const findSub = (user: number, id: string) => {
    const s = subs.find((s) => s.user.id === user && s.charges.includes(id))
    if (!s) throw new BadRequest('CHARGE_ID_INVALID')
    return s
  }

  const methods: Record<string, (p: Record<string, unknown>) => unknown> = {
    getMe: () => ({ id: bot, is_bot: true, first_name: 'Test Bot', username: 'test_bot' }),
    sendMessage: (p) => {
      const m = message(Number(p.chat_id), { text: String(p.text) })
      sent.push(m)
      return m
    },
    sendInvoice: (p) => {
      const inv = invoice({ ...p, subscription_period: 0 })
      const m = message(Number(p.chat_id), {
        invoice: {
          title: inv.title,
          description: inv.description,
          start_parameter: '',
          currency: 'XTR',
          total_amount: inv.amount,
        },
      })
      invoices.set(`msg${m.message_id}`, inv)
      return m
    },
    createInvoiceLink: (p) => {
      const url = `https://t.me/$TEST${++n}`
      invoices.set(url, invoice(p))
      return url
    },
    answerPreCheckoutQuery: (p) => {
      const id = String(p.pre_checkout_query_id)
      if (answers.get(id) !== null) {
        throw new BadRequest('query is too old and response timeout expired or query ID is invalid')
      }
      if (!p.ok && !p.error_message) throw new BadRequest('parameter "error_message" is required')
      answers.set(id, { ok: !!p.ok, error_message: String(p.error_message ?? '') })
      return true
    },
    refundStarPayment: async (p) => {
      const id = String(p.telegram_payment_charge_id)
      const c = charges.get(id)
      if (!c || c.user !== p.user_id) throw new BadRequest('CHARGE_ID_EMPTY')
      if (c.refunded) throw new BadRequest('CHARGE_ALREADY_REFUNDED')
      c.refunded = true
      balance -= c.amount
      const u = toUser(c.user)
      transactions.push({
        id,
        amount: c.amount,
        date: sec(t),
        receiver: { type: 'user', transaction_type: 'invoice_payment', user: u },
      })
      await emit({
        message: message(c.user, {
          from: u,
          refunded_payment: {
            currency: 'XTR',
            total_amount: c.amount,
            invoice_payload: c.payload,
            telegram_payment_charge_id: id,
          },
        }),
      })
      return true
    },
    editUserStarSubscription: (p) => {
      const s = findSub(Number(p.user_id), String(p.telegram_payment_charge_id))
      if (s.until <= t) throw new BadRequest('SUBSCRIPTION_NOT_ACTIVE')
      s.botCanceled = !!p.is_canceled
      if (s.botCanceled) s.renew = false
      return true
    },
    getStarTransactions: (p) => {
      const offset = Number(p.offset ?? 0)
      const limit = Number(p.limit ?? 100)
      return { transactions: transactions.slice(offset, offset + limit) }
    },
    getMyStarBalance: () => ({ amount: balance }),
  }

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const f: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const [, key, method] = /\/bot([^/]+)\/(\w+)$/.exec(url) ?? []
    if (key !== token)
      return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    const fn = methods[method!]
    if (!fn) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      return reply(200, { ok: true, result: await fn(body) })
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      return reply(400, { ok: false, error_code: 400, description: `Bad Request: ${e.message}` })
    }
  }

  const setRenew = async (user: number, id: string, renew: boolean) => {
    const s = findSub(user, id)
    if (s.until <= t) throw new Error('tgstars/testing: this subscription has ended')
    if (renew && s.botCanceled)
      throw new Error('tgstars/testing: the bot canceled this subscription')
    s.renew = renew
    await emit({
      subscription: {
        user: s.user,
        invoice_payload: s.payload,
        state: renew ? 'active' : 'canceled',
      },
    })
  }

  return {
    token,
    fetch: f,
    now: () => t,
    get balance() {
      return balance
    },
    transactions,
    sent,
    connect(h) {
      handler = h
    },
    async pay(who, inv) {
      const u = toUser(who)
      const i = invoices.get(typeof inv === 'string' ? inv : `msg${inv.message_id}`)
      if (!i) throw new Error('tgstars/testing: unknown invoice')
      const qid = `q${++n}`
      answers.set(qid, null)
      await emit({
        pre_checkout_query: {
          id: qid,
          from: u,
          currency: 'XTR',
          total_amount: i.amount,
          invoice_payload: i.payload,
        },
      })
      const a = answers.get(qid)
      answers.delete(qid)
      if (!a) return { ok: false, error: 'no answer' }
      if (!a.ok) return { ok: false, error: a.error_message! }
      const id = charge(u, i.amount, i.payload, i.period)
      if (i.period) {
        const until = t + i.period * 1000
        subs.push({
          user: u,
          payload: i.payload,
          amount: i.amount,
          charges: [id],
          until,
          renew: true,
          botCanceled: false,
          failing: false,
        })
        await paid(u, id, i.amount, i.payload, {
          subscription_expiration_date: sec(until),
          is_recurring: true,
          is_first_recurring: true,
        })
      } else await paid(u, id, i.amount, i.payload)
      return { ok: true, charge: id }
    },
    cancel: (user, id) => setRenew(user, id, false),
    resume: (user, id) => setRenew(user, id, true),
    fail(user, id) {
      findSub(user, id).failing = true
    },
    async advance(time) {
      const end = t + toMs(time)
      for (;;) {
        const s = subs.filter((s) => s.renew && s.until <= end).sort((a, b) => a.until - b.until)[0]
        if (!s) break
        t = s.until
        if (s.failing) {
          s.renew = false
          await emit({
            subscription: { user: s.user, invoice_payload: s.payload, state: 'failed' },
          })
          continue
        }
        const id = charge(s.user, s.amount, s.payload, MONTH)
        s.charges.push(id)
        s.until += MONTH * 1000
        await paid(s.user, id, s.amount, s.payload, {
          subscription_expiration_date: sec(s.until),
          is_recurring: true,
        })
      }
      t = end
    },
  }
}
