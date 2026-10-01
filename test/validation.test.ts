import { describe, expect, it } from 'vitest'
import { toMs } from '../src/duration.ts'
import { type Product, tgstars } from '../src/index.ts'
import { setup } from './helpers.ts'

const token = '123:abc'
const coffee: Product = { title: 'Coffee', description: 'Hot', price: 5 }
const make =
  (products: Record<string, Product>, extra = {}) =>
  () =>
    tgstars({ token, products, ...extra })

describe('validation', () => {
  it('checks the token', () => {
    expect(() => tgstars({ token: 'nope', products: {} })).toThrow('tgstars: bad bot token')
    expect(() => tgstars({ token: '0:abc', products: {} })).toThrow(TypeError)
    expect(tgstars({ token, products: {} }).bot).toBe(123)
  })

  it('checks product names', () => {
    expect(make({ '': coffee })).toThrow('bad product name ""')
    expect(make({ 'a|b': coffee })).toThrow(TypeError)
    expect(make({ ['x'.repeat(129)]: coffee })).toThrow(TypeError)
  })

  it('checks titles and descriptions', () => {
    expect(make({ a: { ...coffee, title: '' } })).toThrow('a title must be 1-32 characters')
    expect(make({ a: { ...coffee, title: 'x'.repeat(33) } })).toThrow(RangeError)
    expect(make({ a: { ...coffee, description: '' } })).toThrow('description must be 1-255')
    expect(make({ a: { ...coffee, description: 'x'.repeat(256) } })).toThrow(RangeError)
  })

  it('checks prices', () => {
    expect(make({ a: { ...coffee, price: 0 } })).toThrow(
      'a price must be a whole number of stars, got 0',
    )
    expect(make({ a: { ...coffee, price: 1.5 } })).toThrow(RangeError)
    expect(make({ a: { ...coffee, price: Number.NaN } })).toThrow(RangeError)
    expect(make({ a: { ...coffee, price: 10001, monthly: true } })).toThrow(
      'a monthly price must be 1-10000 stars, got 10001',
    )
    expect(make({ a: { ...coffee, monthly: true, once: true } })).toThrow("can't be both")
    expect(make({ a: { ...coffee, price: 10000, monthly: true } })).not.toThrow()
    expect(make({ a: { ...coffee, price: 50000 } })).not.toThrow()
  })

  it('checks options', () => {
    expect(make({}, { timeout: 0 })).toThrow('timeout must be 1ms-9s')
    expect(make({}, { timeout: '10s' })).toThrow(RangeError)
    expect(make({}, { timeout: '9s' })).not.toThrow()
    expect(make({}, { timeout: 'soon' })).toThrow('bad duration soon')
    expect(make({}, { grace: -1 })).toThrow(TypeError)
  })

  it('checks invoices before sending them', async () => {
    const { stars } = setup()
    await expect(stars.send(1, 'coffee', { title: 'x'.repeat(40) })).rejects.toThrow(RangeError)
    await expect(stars.send(1, 'coffee', { data: 'x'.repeat(125) })).rejects.toThrow(
      'is over 128 bytes',
    )
    await expect(stars.send(1, 'pack', { data: 'many' })).rejects.toThrow('got NaN')
    await expect(stars.send(1, 'toString' as never)).rejects.toThrow('unknown product toString')
    await expect(stars.link('nope' as never)).rejects.toThrow(TypeError)
  })
})

describe('durations', () => {
  it('parses', () => {
    expect(toMs(5)).toBe(5)
    expect(toMs('250ms')).toBe(250)
    expect(toMs('1.5h')).toBe(5.4e6)
    expect(toMs('2d')).toBe(1728e5)
    expect(() => toMs('1w' as never)).toThrow(TypeError)
    expect(() => toMs(Number.POSITIVE_INFINITY)).toThrow(TypeError)
    expect(() => toMs('-1s')).toThrow(TypeError)
  })
})
