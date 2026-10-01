import type { Ctx } from './options.ts'
import { decode } from './products.ts'
import { isRenewal } from './subs.ts'
import type { StarTransaction } from './types.ts'

export interface SyncOptions {
  deliver?: boolean
}

export interface SyncResult {
  payments: number
  refunds: number
}

const PAGE = 100

const mark = (tx: StarTransaction) => `${tx.id}:${tx.date}:${tx.source ? 'in' : 'out'}`

export const syncer = (c: Ctx): ((opts?: SyncOptions) => Promise<SyncResult>) => {
  const { bot, call, store } = c

  const page = async (offset: number, limit: number) =>
    (await call<{ transactions: StarTransaction[] }>('getStarTransactions', { offset, limit }))
      .transactions

  const run = async ({ deliver }: SyncOptions) => {
    const cur = await store.cursor(bot)
    const go = deliver ?? !!cur?.ready
    let offset = cur?.offset ?? 0
    let last = cur?.last ?? ''
    if (cur && offset) {
      const [tx] = await page(offset - 1, 1)
      if (!tx || mark(tx) !== last) offset = 0
    }

    const res = { payments: 0, refunds: 0 }
    for (;;) {
      const txs = await page(offset, PAGE)
      for (const tx of txs) {
        const src = tx.source
        if (src?.type === 'user' && src.transaction_type === 'invoice_payment' && src.user) {
          const added = await store.add(bot, {
            id: tx.id,
            user: src.user.id,
            ...decode(src.invoice_payload ?? ''),
            amount: tx.amount,
            date: tx.date * 1000,
            until: src.subscription_period ? (tx.date + src.subscription_period) * 1000 : null,
            refunded: false,
            delivered: !go,
            refundDelivered: !go,
            canceled: null,
          })
          if (added) res.payments++
        } else if (tx.receiver?.type === 'user') {
          const p = await store.get(bot, tx.id)
          if (!p || p.refunded) continue
          await store.patch(bot, p.id, { refunded: true, refundDelivered: !go })
          res.refunds++
        }
      }
      offset += txs.length
      if (txs.length) last = mark(txs.at(-1)!)
      if (txs.length < PAGE) break
      await store.setCursor(bot, { offset, last, ready: !!cur?.ready })
    }
    await store.setCursor(bot, { offset, last, ready: true })

    if (go) {
      const errors: unknown[] = []
      for (const p of await store.pending(bot)) {
        try {
          if (!p.delivered) {
            await c.deliver(p.id, isRenewal(await store.list(bot, p.user), p), p.user)
          }
          if (p.refunded) await c.notify(p.id)
        } catch (e) {
          errors.push(e)
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, `tgstars: ${errors.length} deliveries failed in sync`)
      }
    }
    return res
  }

  let running: Promise<SyncResult> | undefined
  return (opts = {}) => {
    running ??= run(opts).finally(() => {
      running = undefined
    })
    return running
  }
}
