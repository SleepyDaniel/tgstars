import { tgstars } from '../dist/index.js'
import { sql } from '../dist/sql.js'
import { fake } from '../dist/testing.js'

const tg = fake()
const paid = []
const stars = tgstars({
  token: tg.token,
  fetch: tg.fetch,
  now: tg.now,
  products: {
    coffee: { title: 'Coffee', description: 'Buy me a coffee', price: 25 },
    pro: { title: 'Pro', description: 'Everything', price: 250, monthly: true },
  },
  onPaid: (p) => paid.push(p),
})
tg.connect(stars.handle)

const { charge } = await tg.pay(42, await stars.send(42, 'coffee'))
await tg.pay(42, await stars.link('pro'))
await tg.advance('30d')
if (paid.length !== 3 || !paid[2].renewal) throw new Error(`unexpected payments: ${paid.length}`)
if (!(await stars.refund(charge)) || (await stars.has(42, 'coffee')))
  throw new Error('refund failed')
if (!(await stars.has(42, 'pro'))) throw new Error('subscription lost')
if ((await stars.balance()).stars !== 500) throw new Error('bad balance')
if (typeof sql({ dialect: 'sqlite', query: () => [] }).add !== 'function') throw new Error('no sql')
console.log('ok')
