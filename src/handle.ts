import { type Ctx, text } from './options.ts'
import { decode, priceOf, type Text } from './products.ts'
import { chain } from './subs.ts'
import type { Message, PreCheckoutQuery, SubscriptionUpdate, Update } from './types.ts'

const LATE = Symbol()
const COMMAND = /^\/(terms|paysupport)(?:@\w+)?(?:\s|$)/

export const handler = (c: Ctx): ((update: unknown) => Promise<boolean>) => {
  const { bot, call, store, o, msg } = c

  const checkout = async (q: PreCheckoutQuery) => {
    const answer = (err?: Text) =>
      call('answerPreCheckoutQuery', {
        pre_checkout_query_id: q.id,
        ok: !err,
        ...(err && { error_message: text(err, q.from) }),
      })
    const { product, data } = decode(q.invoice_payload)
    const p = Object.hasOwn(c.products, product) ? c.products[product] : undefined
    if (!p) return answer(msg.unavailable)

    let price: number
    try {
      price = priceOf(product, p, data)
    } catch {
      return answer(msg.unavailable)
    }
    if (price !== q.total_amount) return answer(msg.stale)

    if (p.once || p.monthly) {
      const now = c.now()
      const owned = (await store.list(bot, q.from.id)).some(
        (x) =>
          x.product === product &&
          x.data === data &&
          !x.refunded &&
          (p.once || (x.until !== null && x.until > now)),
      )
      if (owned) return answer(msg.owned)
    }

    if (!o.check) return answer()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = await Promise.race([
        (async () => o.check!({ id: q.id, user: q.from, product, data, amount: price }))(),
        new Promise<typeof LATE>((r) => {
          timer = setTimeout(r, c.timeout, LATE)
        }),
      ])
      if (res === LATE) throw new Error(`tgstars: check took longer than ${c.timeout}ms`)
      if (res === false || res === '') return answer(msg.declined)
      return answer(typeof res === 'string' ? res : undefined)
    } catch (e) {
      o.onError?.(e)
      return answer(msg.failed)
    } finally {
      clearTimeout(timer)
    }
  }

  const paid = async (m: Message) => {
    const sp = m.successful_payment!
    const { product, data } = decode(sp.invoice_payload)
    const user = m.from?.id ?? m.chat.id
    const exp = sp.subscription_expiration_date
    const renewal = !!sp.is_recurring && !sp.is_first_recurring
    if (renewal) {
      const last = chain(await store.list(bot, user), product, data).at(-1)
      if (last?.canceled === 'user') await store.patch(bot, last.id, { canceled: null })
    }
    await store.add(bot, {
      id: sp.telegram_payment_charge_id,
      user,
      product,
      data,
      amount: sp.total_amount,
      date: m.date * 1000,
      until: exp ? exp * 1000 : null,
      refunded: false,
      delivered: false,
      refundDelivered: false,
      canceled: null,
    })
    await c.deliver(sp.telegram_payment_charge_id, renewal, m.chat.id)
  }

  const refunded = async (m: Message) => {
    const r = m.refunded_payment!
    const id = r.telegram_payment_charge_id
    const added = await store.add(bot, {
      id,
      user: m.from?.id ?? m.chat.id,
      ...decode(r.invoice_payload),
      amount: r.total_amount,
      date: m.date * 1000,
      until: null,
      refunded: true,
      delivered: true,
      refundDelivered: false,
      canceled: null,
    })
    if (!added) await store.patch(bot, id, { refunded: true })
    await c.notify(id)
  }

  const subscription = async (s: SubscriptionUpdate) => {
    const { product, data } = decode(s.invoice_payload)
    const last = chain(await store.list(bot, s.user.id), product, data).at(-1)
    if (last && s.state !== 'failed') {
      await store.patch(bot, last.id, { canceled: s.state === 'canceled' ? 'user' : null })
    }
    await o.onSubscription?.({ user: s.user, product, data, state: s.state })
  }

  const command = async (m: Message) => {
    const cmd = COMMAND.exec(m.text!)?.[1]
    const t = cmd === 'terms' ? o.terms : cmd === 'paysupport' ? o.support : undefined
    if (t === undefined) return false
    await call('sendMessage', { chat_id: m.chat.id, text: text(t, m.from!) })
    return true
  }

  return async (update) => {
    const u = (update ?? {}) as Update
    const m = u.message
    if (u.pre_checkout_query?.currency === 'XTR') await checkout(u.pre_checkout_query)
    else if (u.subscription) await subscription(u.subscription)
    else if (m?.successful_payment?.currency === 'XTR') await paid(m)
    else if (m?.refunded_payment?.currency === 'XTR') await refunded(m)
    else if (m?.text && m.from && m.chat.type === 'private') return command(m)
    else return false
    return true
  }
}
