import { describe, expect, it } from 'vitest'
import { en } from './en'
import { zh } from './zh'

describe('dictionary parity', () => {
  it('defines the same keys in both locales', () => {
    // `Dict` is a plain record, so a key added to one locale silently renders as
    // the raw key in the other.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('never defines an empty string', () => {
    for (const [locale, dict] of [
      ['en', en],
      ['zh', zh],
    ] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })
})
