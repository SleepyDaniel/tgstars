import { DatabaseSync } from 'node:sqlite'
import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { memory, type Payment, type Store } from '../src/index.ts'
import { sql } from '../src/sql.ts'
import { setup } from './helpers.ts'

const pay = (id: string, extra: Partial<Payment> = {}): Payment => ({
  id,
  user: 7_000_000_001,
  product: 'pro',
  data: 'a|b',
  amount: 250,
  date: 1_767_225_600_000,
  until: 1_769_817_600_000,
  refunded: false,
  delivered: false,
  refundDelivered: false,
  canceled: null,
  ...extra,
})

const lite = (table?: string) => {
  const db = new DatabaseSync(':memory:')
  return sql({
    dialect: 'sqlite',
    query: (q, p) => db.prepare(q).all(...p),
    ...(table && { table }),
  })
}

const pgShim = () => {
  const db = new DatabaseSync(':memory:')
  return sql({
    dialect: 'postgres',
    table: 'user',
    query: (q, p) => db.prepare(q.replace(/\$(\d+)/g, '?$1')).all(...p),
  })
}

const url = process.env.POSTGRES_URL
const pg = url ? postgres(url, { onnotice: () => {} }) : undefined
const tables: string[] = []
afterAll(async () => {
  for (const t of tables) await pg!.unsafe(`drop table if exists "${t}", "${t}_cursor"`)
  await pg?.end()
})

const stores: [string, () => Store][] = [
  ['memory', memory],
  ['sqlite', () => lite()],
  ['sqlite with a reserved table name', () => lite('order')],
  ['postgres dialect on sqlite', pgShim],
]
if (pg) {
  stores.push([
    'postgres',
    () => {
      const table = `t${Math.random().toString(36).slice(2)}`
      tables.push(table)
      return sql({ dialect: 'postgres', table, query: (q, p) => pg.unsafe(q, p) })
    },
  ])
}

describe.each(stores)('%s store', (_, make) => {
  it('adds each payment once', async () => {
    const s = make()
    expect(await s.add(1, pay('a'))).toBe(true)
    expect(await s.add(1, pay('a', { amount: 1 }))).toBe(false)
    expect(await s.add(2, pay('a'))).toBe(true)
    expect(await s.get(1, 'a')).toEqual(pay('a'))
    expect(await s.get(1, 'b')).toBeUndefined()
  })

  it('lists by user in date order', async () => {
    const s = make()
    await s.add(1, pay('b', { date: 2, until: null }))
    await s.add(1, pay('a', { date: 1 }))
    await s.add(1, pay('c', { user: 5 }))
    await s.add(2, pay('d'))
    expect((await s.list(1, 7_000_000_001)).map((p) => p.id)).toEqual(['a', 'b'])
    expect((await s.list(1, 7_000_000_001))[1]!.until).toBeNull()
    expect(await s.list(1, 9)).toEqual([])
  })

  it('patches payments and finds the pending ones', async () => {
    const s = make()
    await s.add(1, pay('a', { date: 3 }))
    await s.add(1, pay('b', { date: 2 }))
    await s.add(1, pay('c', { date: 1, delivered: true, refunded: true }))
    await s.add(1, pay('d', { delivered: true }))
    await s.add(2, pay('e'))
    await s.patch(1, 'a', {
      delivered: true,
      refunded: true,
      refundDelivered: true,
      canceled: 'bot',
    })
    await s.patch(1, 'b', {})
    await s.patch(1, 'b', { nope: 1 } as never)
    await s.patch(1, 'b', { until: null, amount: 3, canceled: 'user' })
    await s.patch(1, 'x', { delivered: true })
    expect(await s.get(1, 'a')).toEqual(
      pay('a', {
        date: 3,
        delivered: true,
        refunded: true,
        refundDelivered: true,
        canceled: 'bot',
      }),
    )
    expect(await s.get(1, 'b')).toMatchObject({ until: null, amount: 3, canceled: 'user' })
    expect((await s.pending(1)).map((p) => p.id)).toEqual(['c', 'b'])
  })

  it('lets one caller claim a payment until the lease ends', async () => {
    const s = make()
    await s.add(1, pay('a'))
    expect(await s.claim(1, 'x', 0, 100)).toBe(false)
    expect(await s.claim(1, 'a', 0, 100)).toBe(true)
    expect(await s.claim(1, 'a', 50, 150)).toBe(false)
    expect(await s.claim(1, 'a', 100, 200)).toBe(true)
    await s.unclaim(1, 'a')
    expect(await s.claim(1, 'a', 101, 300)).toBe(true)
    expect(await s.get(1, 'a')).toEqual(pay('a'))
  })

  it('keeps a cursor per bot', async () => {
    const s = make()
    expect(await s.cursor(1)).toBeUndefined()
    await s.setCursor(1, { offset: 5, last: 'x', ready: false })
    await s.setCursor(1, { offset: 9, last: 'y', ready: true })
    await s.setCursor(2, { offset: 1, last: 'z', ready: false })
    expect(await s.cursor(1)).toEqual({ offset: 9, last: 'y', ready: true })
    expect(await s.cursor(2)).toEqual({ offset: 1, last: 'z', ready: false })
  })

  it('runs a full payment flow', async () => {
    const { tg, stars, paid, refunds } = setup({ store: make() })
    await stars.sync()
    const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
    await tg.pay(42, await stars.link('pro'))
    await stars.refund(charge!)
    await tg.advance('30d')
    expect(await stars.cancel(42, 'pro')).toBe(true)
    expect(await stars.has(42, 'pro')).toBe(true)
    expect(await stars.has(42, 'coffee')).toBe(false)
    expect(paid.map((p) => p.renewal)).toEqual([false, false, true])
    expect(refunds).toHaveLength(1)
    expect(await stars.sync()).toEqual({ payments: 0, refunds: 0 })
  })
})

describe('sql', () => {
  it('checks its options', () => {
    const query = () => []
    expect(() => sql({ dialect: 'mysql' as never, query })).toThrow(
      'dialect must be postgres or sqlite',
    )
    expect(() => sql({ dialect: 'sqlite', query, table: 'x"; drop' })).toThrow('bad table name')
  })

  it('retries setup after a failure', async () => {
    const db = new DatabaseSync(':memory:')
    let down = true
    const s = sql({
      dialect: 'sqlite',
      table: 'payments',
      query: (q, p) => {
        if (down) throw new Error('db down')
        return db.prepare(q).all(...p)
      },
    })
    await expect(s.cursor(1)).rejects.toThrow('db down')
    down = false
    expect(await s.add(1, pay('a'))).toBe(true)
    expect(db.prepare('select id from payments').all()).toEqual([{ id: 'a' }])
  })
})
