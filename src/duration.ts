const units = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }

export type Duration = number | `${number}${keyof typeof units}`

export const toMs = (d: Duration): number => {
  const m = typeof d === 'number' ? null : /^(.+?)(ms|[smhd])$/.exec(d)
  const ms = m ? +m[1]! * units[m[2] as keyof typeof units] : d
  if (!(typeof ms === 'number' && ms >= 0 && ms < Infinity)) {
    throw new TypeError(`tgstars: bad duration ${d}`)
  }
  return ms
}
