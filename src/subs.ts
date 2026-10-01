import type { Payment } from './store.ts'

const DAY = 864e5

const renews = (prev: Payment, p: Payment) =>
  !prev.canceled && Math.abs(prev.until! - p.date) <= DAY

export const chain = (list: Payment[], product: string, data: string): Payment[] => {
  const subs = list.filter((p) => p.product === product && p.data === data && p.until !== null)
  let i = subs.length - 1
  while (i > 0 && renews(subs[i - 1]!, subs[i]!)) i--
  return subs.slice(Math.max(i, 0))
}

export const isRenewal = (list: Payment[], p: Payment): boolean => {
  const prev = list.filter(
    (x) => x.product === p.product && x.data === p.data && x.until !== null && x.date < p.date,
  )
  return p.until !== null && prev.length > 0 && renews(prev.at(-1)!, p)
}
