import { describe, it, expect } from 'vitest'
import { getFallbackVoices } from './voices'

describe('getFallbackVoices', () => {
  it('returns localized Chinese aliases for zh-CN fallback list', () => {
    const voices = getFallbackVoices('zh-CN')
    expect(voices.some(v => /杰西卡|瑞秋|贝拉|乔什|亚当/.test(v.name))).toBe(true)
  })

  it('keeps canonical English names for en fallback list', () => {
    const voices = getFallbackVoices('en')
    expect(voices.some(v => v.name === 'Jessica')).toBe(true)
  })
})
