import { describe, expect, it } from 'vitest'
import { buildEventSubscription, getSubscriptionKey } from './subscriptionBuilder'

describe('buildEventSubscription', () => {
  it('当有 sessionId 时返回 sessionId 订阅', () => {
    const result = buildEventSubscription('session-123')

    expect(result).toEqual({ sessionId: 'session-123' })
    expect(result.all).toBeUndefined()
  })

  it('当 sessionId 为 null 时返回 all 订阅', () => {
    const result = buildEventSubscription(null)

    expect(result).toEqual({ all: true })
    expect(result.sessionId).toBeUndefined()
  })
})

describe('getSubscriptionKey', () => {
  it('为 all 订阅生成键', () => {
    const key = getSubscriptionKey({ all: true })

    expect(key).toBe('1||')
  })

  it('为 sessionId 订阅生成键', () => {
    const key = getSubscriptionKey({ sessionId: 'session-123' })

    expect(key).toBe('0|session-123|')
  })

  it('为 machineId 订阅生成键', () => {
    const key = getSubscriptionKey({ machineId: 'machine-456' })

    expect(key).toBe('0||machine-456')
  })

  it('为组合订阅生成键', () => {
    const key = getSubscriptionKey({
      sessionId: 'session-123',
      machineId: 'machine-456'
    })

    expect(key).toBe('0|session-123|machine-456')
  })

  it('为空订阅生成键', () => {
    const key = getSubscriptionKey({})

    expect(key).toBe('0||')
  })

  it('all 优先级高于其他字段', () => {
    const key = getSubscriptionKey({
      all: true,
      sessionId: 'session-123',
      machineId: 'machine-456'
    })

    expect(key).toBe('1|session-123|machine-456')
  })

  it('all: false 时生成正常键', () => {
    const key = getSubscriptionKey({
      all: false,
      sessionId: 'session-123'
    })

    expect(key).toBe('0|session-123|')
  })
})
