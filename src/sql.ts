import type { Payment, Store } from './store.ts'

export type Query = (
  sql: string,
  params: (string | number | null)[],
) => unknown[] | Promise<unknown[]>

export interface SqlOptions {
  query: Query
  dialect: 'postgres' | 'sqlite'
  table?: string
}

type Row = Record<string, unknown>
type Params = Parameters<Query>[1]

const COLS = [
  'id',
  'user',
  'product',
  'data',
  'amount',
  'date',
  'until',
  'refunded',
  'delivered',
  'refundDelivered',
  'canceled',
]

const row = (r: Row): Payment => ({
  id: String(r.id),
  user: Number(r.user),
  product: String(r.product),
  data: String(r.data),
  amount: Number(r.amount),
  date: Number(r.date),
  until: r.until == null ? null : Number(r.until),
  refunded: !!Number(r.refunded),
  delivered: !!Number(r.delivered),
  refundDelivered: !!Number(r.refundDelivered),
  canceled: r.canceled == null ? null : (String(r.canceled) as 'user' | 'bot'),
})

const value = (v: unknown) => (typeof v === 'boolean' ? +v : (v as string | number | null))

export const sql = ({ query, dialect, table = 'tgstars' }: SqlOptions): Store => {
  if (dialect !== 'postgres' && dialect !== 'sqlite') {
    throw new TypeError(`tgstars: dialect must be postgres or sqlite, got ${dialect}`)
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new TypeError(`tgstars: bad table name ${table}`)
  const big = dialect === 'postgres' ? 'bigint' : 'integer'
  const t = `"${table}"`
  const tc = `"${table}_cursor"`
  const cols = COLS.map((c) => `"${c}"`).join(', ')

  const raw = async (s: string, p: Params = []) =>
    (await query(dialect === 'sqlite' ? s.replace(/\$(\d+)/g, '?$1') : s, p)) as Row[]

  const setup = async () => {
    await raw(`create table if not exists ${t} (
      "bot" ${big} not null, "id" text not null, "user" ${big} not null, "product" text not null,
      "data" text not null, "amount" integer not null, "date" ${big} not null, "until" ${big},
      "refunded" integer not null, "delivered" integer not null,
      "refundDelivered" integer not null, "canceled" text, "lock" ${big},
      primary key ("bot", "id"))`)
    await raw(`create index if not exists "${table}_user" on ${t} ("bot", "user")`)
    await raw(`create table if not exists ${tc} (
      "bot" ${big} primary key, "offset" integer not null, "last" text not null,
      "ready" integer not null)`)
  }

  let ready: Promise<void> | undefined
  const q = async (s: string, p: Params) => {
    ready ??= setup().catch((e) => {
      ready = undefined
      throw e
    })
    await ready
    return raw(s, p)
  }

  return {
    async add(bot, p) {
      const rows = await q(
        `insert into ${t} ("bot", ${cols})
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        on conflict do nothing returning "id"`,
        [bot, ...COLS.map((k) => value(p[k as keyof Payment]))],
      )
      return rows.length > 0
    },
    async get(bot, id) {
      const [r] = await q(`select * from ${t} where "bot" = $1 and "id" = $2`, [bot, id])
      return r && row(r)
    },
    async list(bot, user) {
      const rows = await q(`select * from ${t} where "bot" = $1 and "user" = $2 order by "date"`, [
        bot,
        user,
      ])
      return rows.map(row)
    },
    async pending(bot) {
      const rows = await q(
        `select * from ${t} where "bot" = $1
        and ("delivered" = 0 or ("refunded" = 1 and "refundDelivered" = 0)) order by "date"`,
        [bot],
      )
      return rows.map(row)
    },
    async patch(bot, id, p) {
      const keys = Object.keys(p).filter((k) => COLS.includes(k))
      if (!keys.length) return
      const set = keys.map((k, i) => `"${k}" = $${i + 3}`).join(', ')
      const vals = keys.map((k) => value(p[k as keyof Payment]))
      await q(`update ${t} set ${set} where "bot" = $1 and "id" = $2`, [bot, id, ...vals])
    },
    async claim(bot, id, now, until) {
      const rows = await q(
        `update ${t} set "lock" = $3 where "bot" = $1 and "id" = $2
        and ("lock" is null or "lock" <= $4) returning "id"`,
        [bot, id, until, now],
      )
      return rows.length > 0
    },
    async unclaim(bot, id) {
      await q(`update ${t} set "lock" = null where "bot" = $1 and "id" = $2`, [bot, id])
    },
    async cursor(bot) {
      const [r] = await q(`select * from ${tc} where "bot" = $1`, [bot])
      return r && { offset: Number(r.offset), last: String(r.last), ready: !!Number(r.ready) }
    },
    async setCursor(bot, c) {
      await q(
        `insert into ${tc} ("bot", "offset", "last", "ready") values ($1, $2, $3, $4)
        on conflict ("bot") do update
        set "offset" = excluded."offset", "last" = excluded."last", "ready" = excluded."ready"`,
        [bot, c.offset, c.last, +c.ready],
      )
    },
  }
}
