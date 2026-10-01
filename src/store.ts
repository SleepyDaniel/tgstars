export interface Payment {
  id: string
  user: number
  product: string
  data: string
  amount: number
  date: number
  until: number | null
  refunded: boolean
  delivered: boolean
  refundDelivered: boolean
  canceled: 'user' | 'bot' | null
}

export interface Cursor {
  offset: number
  last: string
  ready: boolean
}

export interface Store {
  add(bot: number, p: Payment): Promise<boolean>
  get(bot: number, id: string): Promise<Payment | undefined>
  list(bot: number, user: number): Promise<Payment[]>
  pending(bot: number): Promise<Payment[]>
  patch(bot: number, id: string, p: Partial<Payment>): Promise<void>
  claim(bot: number, id: string, now: number, until: number): Promise<boolean>
  unclaim(bot: number, id: string): Promise<void>
  cursor(bot: number): Promise<Cursor | undefined>
  setCursor(bot: number, c: Cursor): Promise<void>
}

export const memory = (): Store => {
  const byId = new Map<string, Payment>()
  const byUser = new Map<string, Payment[]>()
  const locks = new Map<string, number>()
  const cursors = new Map<number, Cursor>()

  return {
    async add(bot, p) {
      const k = `${bot}:${p.id}`
      if (byId.has(k)) return false
      const copy = { ...p }
      byId.set(k, copy)
      const u = `${bot}:${p.user}`
      const list = byUser.get(u)
      if (list) list.push(copy)
      else byUser.set(u, [copy])
      return true
    },
    async get(bot, id) {
      const p = byId.get(`${bot}:${id}`)
      return p && { ...p }
    },
    async list(bot, user) {
      return (byUser.get(`${bot}:${user}`) ?? [])
        .map((p) => ({ ...p }))
        .sort((a, b) => a.date - b.date)
    },
    async pending(bot) {
      const out: Payment[] = []
      for (const [k, p] of byId) {
        if (!k.startsWith(`${bot}:`)) continue
        if (!p.delivered || (p.refunded && !p.refundDelivered)) out.push({ ...p })
      }
      return out.sort((a, b) => a.date - b.date)
    },
    async patch(bot, id, p) {
      const cur = byId.get(`${bot}:${id}`)
      if (cur) Object.assign(cur, p)
    },
    async claim(bot, id, now, until) {
      const k = `${bot}:${id}`
      if (!byId.has(k) || (locks.get(k) ?? 0) > now) return false
      locks.set(k, until)
      return true
    },
    async unclaim(bot, id) {
      locks.delete(`${bot}:${id}`)
    },
    async cursor(bot) {
      const c = cursors.get(bot)
      return c && { ...c }
    },
    async setCursor(bot, c) {
      cursors.set(bot, { ...c })
    },
  }
}
