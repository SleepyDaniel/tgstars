import type { User } from './types.ts'

export type Text = string | ((user: User) => string)

export interface Product {
  title: string
  description: string
  price: number | ((data: string) => number)
  monthly?: boolean
  once?: boolean
  photo?: string
}

export const MONTH = 2592000
export const TEST_MONTH = 300

const bytes = (s: string) => new TextEncoder().encode(s).length

export const checkText = (key: string, title: string, description: string): void => {
  if (!title || title.length > 32) {
    throw new RangeError(`tgstars: ${key} title must be 1-32 characters`)
  }
  if (!description || description.length > 255) {
    throw new RangeError(`tgstars: ${key} description must be 1-255 characters`)
  }
}

export const checkProducts = (products: Record<string, Product>): void => {
  for (const [key, p] of Object.entries(products)) {
    if (!key || key.includes('|') || bytes(key) > 128) {
      throw new TypeError(`tgstars: bad product name "${key}"`)
    }
    checkText(key, p.title, p.description)
    if (p.monthly && p.once) throw new TypeError(`tgstars: ${key} can't be both monthly and once`)
    if (typeof p.price === 'number') priceOf(key, p, '')
  }
}

export const priceOf = (key: string, p: Product, data: string): number => {
  const n = typeof p.price === 'number' ? p.price : p.price(data)
  if (p.monthly && !(Number.isInteger(n) && n >= 1 && n <= 10000)) {
    throw new RangeError(`tgstars: ${key} monthly price must be 1-10000 stars, got ${n}`)
  }
  if (!(Number.isInteger(n) && n >= 1)) {
    throw new RangeError(`tgstars: ${key} price must be a whole number of stars, got ${n}`)
  }
  return n
}

export const encode = (key: string, data: string): string => {
  const s = data ? `${key}|${data}` : key
  if (bytes(s) > 128) throw new RangeError(`tgstars: payload "${s}" is over 128 bytes`)
  return s
}

export const decode = (s: string): { product: string; data: string } => {
  const i = s.indexOf('|')
  return i < 0 ? { product: s, data: '' } : { product: s.slice(0, i), data: s.slice(i + 1) }
}
