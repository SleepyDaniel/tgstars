<p align="center">
    <img src="./.github/assets/banner.png" alt="tgstars banner">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/tgstars"><img alt="npm" src="https://shieldcn.dev/npm/tgstars.svg" /></a>
  <a href="https://github.com/SleepyDaniel/tgstars"><img alt="stars" src="https://shieldcn.dev/github/SleepyDaniel/tgstars/stars.svg" /></a>
  <a href="https://www.npmjs.com/package/tgstars"><img alt="downloads" src="https://shieldcn.dev/npm/dm/tgstars.svg" /></a>
  <a href="https://github.com/SleepyDaniel/tgstars/releases"><img alt="release" src="https://shieldcn.dev/github/SleepyDaniel/tgstars/release.svg" /></a>
</p>

<h1 align="center">tgstars</h1>

A small library for taking Telegram Stars payments in your bot. It sends invoices, handles checkout, subscriptions and refunds, and keeps track of what every user has paid for, which Telegram doesn't do for you. No dependencies, and it works with grammY, Telegraf or plain webhooks.

## Why tgstars

- **Knows who paid:** Telegram won't tell you whether a user is subscribed. tgstars keeps track of every payment, refund and renewal, so you can just ask.
- **Catches up:** if your bot was down, it finds the payments it missed in Telegram's transaction history.
- **Careful checkout:** people can't pay an old price, buy something you removed or buy the same unlock twice.
- **Easy to test:** it comes with a fake Telegram, so you can test payments, renewals and refunds without spending Stars.

## Install

```sh
bun add tgstars
```

```sh
npm i tgstars
```

## Usage

```ts
import { DatabaseSync } from 'node:sqlite'
import { Bot } from 'grammy'
import { tgstars } from 'tgstars'
import { sql } from 'tgstars/sql'

const bot = new Bot(process.env.BOT_TOKEN!)
const db = new DatabaseSync('bot.db')

const stars = tgstars({
  token: process.env.BOT_TOKEN!,
  store: sql({ dialect: 'sqlite', query: (q, params) => db.prepare(q).all(...params) }),
  products: {
    coffee: { title: 'Coffee', description: 'Buy me a coffee', price: 25 },
    pro: { title: 'Pro', description: 'Everything unlocked', price: 250, monthly: true },
  },
  onPaid: async (p) => {
    await grant(p.user, p.product)
    await bot.api.sendMessage(p.chat, 'Thank you!').catch(() => {})
  },
  terms: 'Digital goods, refunds within 7 days via /paysupport.',
  support: 'Write to @your_support and include your payment ID.',
})

bot.use(stars.middleware())

bot.command('coffee', (ctx) => stars.send(ctx.chat.id, 'coffee'))
bot.command('pro', async (ctx) => {
  if (await stars.has(ctx.from!.id, 'pro')) return ctx.reply('You already have Pro.')
  await ctx.reply(`Get Pro: ${await stars.link('pro')}`)
})

await stars.sync()
setInterval(() => stars.sync().catch(console.error), 5 * 60_000)
bot.start()
```

Add the middleware before your own handlers. It takes care of checkouts, payments, refunds and subscription changes, answers `/terms` and `/paysupport` for you, and lets everything else through. Telegraf works the same way, and without a framework you can pass updates to `stars.handle(update)`.

`onPaid` is where you give the user what they bought. If it throws, tgstars tries again later, so only throw when trying again makes sense. 

### Products

| field | type | |
| --- | --- | --- |
| `title` | `string` | 1-32 characters |
| `description` | `string` | 1-255 characters |
| `price` | `number \| (data) => number` | in Stars |
| `monthly` | `boolean` | renews every 30 days, 1-10000 Stars |
| `once` | `boolean` | one per user, like an unlock |
| `photo` | `string` | image URL for the invoice |

Anything that isn't `monthly` or `once` can be bought as many times as the user likes.

You can attach your own string to an invoice with `data`, for example an item id or a quantity. You get it back in `onPaid`, and if `price` is a function, it gets `data` too:

```ts
const stars = tgstars({
  token,
  products: {
    coins: { title: 'Coins', description: '10 Stars per coin', price: (n) => 10 * Number(n) },
  },
})

await stars.send(chatId, 'coins', { data: '5', title: '5 coins' })
```

Keep `data` short, Telegram only allows 128 bytes for the whole invoice payload.

### Invoices and links

`send()` posts an invoice in a chat, and `link()` gives you a link instead that you can put in a button or open from a Mini App. Subscriptions only work as links, that's a Telegram rule.

Both take an optional `{ data, title, description, photo, extra }`. Whatever you put in `extra` is passed on to Telegram, like `reply_markup`.

### Checkout

Before a user pays, tgstars checks that the product still exists, that the price hasn't changed since the invoice was sent, and that they don't already own it. You can add your own check on top:

```ts
const stars = tgstars({
  token,
  products,
  check: async (q) => {
    if (!(await inStock(q.data))) return 'Sold out, sorry!'
  },
})
```

Return a string to turn the payment down with that message, `false` to turn it down with a default one, or nothing to let it through. Telegram only waits 10 seconds for an answer, so if your check throws or takes longer than 8 seconds, the payment is declined and the error goes to `onError`.

You can change any message users see, or pass a function to translate them:

```ts
const stars = tgstars({
  token,
  products,
  messages: {
    stale: (u) => (u.language_code === 'de' ? 'Der Preis hat sich geändert.' : 'The price changed.'),
  },
})
```

### Refunds

```ts
await stars.refund(chargeId)
```

The charge id is `p.id` in `onPaid`. Whenever something a user got is refunded, even from somewhere else, `onRefund` is called, so that's the place to take it back. For a payment tgstars hasn't seen, pass the user id as well: `stars.refund(chargeId, userId)`.

### Subscriptions

Each renewal comes into `onPaid` like any other payment, with `renewal: true`. `onSubscription` tells you when a user cancels or turns renewal back on in Telegram, or when a renewal fails, for example because they ran out of Stars.

```ts
await stars.cancel(userId, 'pro')
await stars.uncancel(userId, 'pro')
```

`cancel()` stops renewal from your side. The user keeps what they paid for until the end of the period, but can't turn renewal back on. `uncancel()` lets them do that again. It can't restart renewal for them though, only the user can.

`has()` keeps saying yes for an hour after a subscription ends, in case a renewal update is late. You can change that with `grace`.

If you've set `allowed_updates` for your bot, make sure it includes `message`, `pre_checkout_query` and `subscription`.

### Storage

By default payments are kept in memory, which is fine for tests but not for a real bot. There you want `tgstars/sql`, which works with Postgres and SQLite and uses whatever driver you already have:

| driver | `dialect` | `query` |
| --- | --- | --- |
| [postgres](https://github.com/porsager/postgres) | `'postgres'` | `(q, params) => db.unsafe(q, params)` |
| [pg](https://node-postgres.com) | `'postgres'` | `(q, params) => pool.query(q, params).then((r) => r.rows)` |
| `node:sqlite` (Node 22.13+) | `'sqlite'` | `(q, params) => db.prepare(q).all(...params)` |
| `bun:sqlite` | `'sqlite'` | `(q, params) => db.query(q).all(...params)` |
| Cloudflare D1 | `'sqlite'` | `(q, params) => env.DB.prepare(q).bind(...params).all().then((r) => r.results)` |

The tables are created the first time they're needed. Several bots, or several copies of the same bot, can share them. For any other database you can write your own store, see [src/store.ts](./src/store.ts).

### Catching up

```ts
await stars.sync()
```

`sync()` goes through the bot's Star transactions, picks up payments and refunds it hasn't seen yet and hands them to `onPaid` and `onRefund`. The first time you run it, it only records what's already there, so old purchases aren't delivered again. Run it when the bot starts and every few minutes after that.

### Webhooks

If you use webhooks, set a secret token. Otherwise anyone who finds the URL can send your bot fake payments:

```ts
await bot.api.setWebhook(url, { secret_token: process.env.WEBHOOK_SECRET! })
app.post('/tg', webhookCallback(bot, 'hono', { secretToken: process.env.WEBHOOK_SECRET! }))
```

Without grammY, compare the `X-Telegram-Bot-Api-Secret-Token` header with your secret yourself.

### Testing

`tgstars/testing` is a fake Telegram that can pay invoices, renew subscriptions and refund, all in memory:

```ts
import { tgstars } from 'tgstars'
import { fake } from 'tgstars/testing'
import { expect, test } from 'vitest'

test('pro subscription', async () => {
  const tg = fake()
  const stars = tgstars({ token: tg.token, fetch: tg.fetch, now: tg.now, products })
  tg.connect(stars.handle)

  const { charge } = await tg.pay(42, await stars.link('pro'))
  expect(await stars.has(42, 'pro')).toBe(true)

  await tg.advance('30d')
  expect(tg.balance).toBe(500)

  await tg.cancel(42, charge!)
  await tg.advance('31d')
  expect(await stars.has(42, 'pro')).toBe(false)
})
```

You can also point your real bot at it:

```ts
const bot = new Bot(tg.token, { client: { fetch: tg.fetch } })
bot.use(stars.middleware())
await bot.init()
tg.connect((u) => bot.handleUpdate(u))
```

| | |
| --- | --- |
| `fake({ bot, now })` | a new fake, optionally with a bot id and start time |
| `tg.pay(user, invoice)` | pays an invoice message or link as that user |
| `tg.advance(time)` | moves time forward, like `'30d'`, and renews subscriptions |
| `tg.cancel(user, charge)` | the user cancels a subscription |
| `tg.resume(user, charge)` | the user turns renewal back on |
| `tg.fail(user, charge)` | the next renewal fails |
| `tg.balance`, `tg.transactions`, `tg.sent` | the bot's Stars, transactions and sent messages |

The errors it returns are copied from Telegram's test environment.

## API

### `tgstars(options)`

| option | type | default | |
| --- | --- | --- | --- |
| `token` | `string` | | bot token |
| `products` | `Record<string, Product>` | | what you sell |
| `store` | `Store` | memory | where payments are kept |
| `onPaid` | `(p: Paid) => unknown` | | a payment came in |
| `onRefund` | `(p: Payment) => unknown` | | a payment was refunded |
| `onSubscription` | `(s) => unknown` | | a user canceled, turned renewal back on, or a renewal failed |
| `check` | `(q) => boolean \| string \| undefined` | | your own check before payment |
| `onError` | `(e) => void` | | errors from `check` |
| `terms` / `support` | `string \| (user) => string` | | replies to `/terms` and `/paysupport` |
| `messages` | `Partial<Messages>` | | `unavailable`, `stale`, `owned`, `declined`, `failed` |
| `grace` | `number \| string` | `'1h'` | how long access lasts after a subscription ends |
| `timeout` | `number \| string` | `'8s'` | time limit for `check`, up to `'9s'` |
| `now` | `() => number` | `Date.now` | clock in ms |
| `fetch` | `Fetch` | global `fetch` | for proxies and tests |
| `apiRoot` | `string` | `'https://api.telegram.org'` | for a local Bot API server |
| `test` | `boolean` | `false` | use Telegram's test environment |

Times can be ms or strings like `'30s'`, `'1h'` or `'2d'`.

| method | returns | |
| --- | --- | --- |
| `send(chat, product, opts?)` | `Promise<Message>` | sends an invoice |
| `link(product, opts?)` | `Promise<string>` | creates an invoice link |
| `has(user, product, data?)` | `Promise<boolean>` | whether the user owns it right now |
| `purchases(user)` | `Promise<Payment[]>` | all their payments, oldest first |
| `refund(charge, user?)` | `Promise<boolean>` | `false` if it was already refunded |
| `cancel(user, product, data?)` | `Promise<boolean>` | stops renewal |
| `uncancel(user, product, data?)` | `Promise<boolean>` | lets the user renew again |
| `balance()` | `Promise<{ stars, nanostars }>` | the bot's balance |
| `sync({ deliver? })` | `Promise<{ payments, refunds }>` | catches up with Telegram, `deliver` forces delivery on or off |
| `handle(update)` | `Promise<boolean>` | handles an update, `true` if it was one for tgstars |
| `middleware()` | middleware | for grammY, Telegraf and anything with `ctx.update` |
| `bot` | `number` | the bot id |

A `Payment` has `id`, `user`, `product`, `data`, `amount`, `date`, `until`, `refunded`, `delivered`, `refundDelivered` and `canceled`. `until` is only set for subscriptions and all dates are in ms. `onPaid` also gets `renewal` and `chat`.

Errors from Telegram are thrown as `TelegramError` with `method`, `code` and `description`. Short rate limits are waited out and retried. If some deliveries fail during `sync()`, the rest still go through and it throws an `AggregateError` at the end.

## Star History

<a href="https://star-history.com/#SleepyDaniel/tgstars&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=SleepyDaniel/tgstars&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=SleepyDaniel/tgstars&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=SleepyDaniel/tgstars&type=Date" />
  </picture>
</a>

## License

MIT © 2026 SleepyDaniel
