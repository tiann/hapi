import { describe, expect, it, vi } from 'vitest'
import { createConnectionTracker, createBaseUrlChangeHandler } from './connectionManager'

describe('createConnectionTracker', () => {
  it('初始状态正确', () => {
    const tracker = createConnectionTracker()

    expect(tracker.isFirstConnect).toBe(true)
    expect(tracker.syncToken).toBe(0)
    expect(tracker.baseUrl).toBe('')
  })

  it('markConnected 更新状态', () => {
    const tracker = createConnectionTracker()

    tracker.markConnected()

    expect(tracker.isFirstConnect).toBe(false)
    expect(tracker.syncToken).toBe(1)
  })

  it('多次 markConnected 递增 syncToken', () => {
    const tracker = createConnectionTracker()

    tracker.markConnected()
    tracker.markConnected()
    tracker.markConnected()

    expect(tracker.isFirstConnect).toBe(false)
    expect(tracker.syncToken).toBe(3)
  })

  it('updateBaseUrl 更新 baseUrl', () => {
    const tracker = createConnectionTracker()

    tracker.updateBaseUrl('http://example.com')

    expect(tracker.baseUrl).toBe('http://example.com')
  })

  it('reset 重置所有状态', () => {
    const tracker = createConnectionTracker()

    tracker.markConnected()
    tracker.markConnected()
    tracker.updateBaseUrl('http://example.com')

    tracker.reset()

    expect(tracker.isFirstConnect).toBe(true)
    expect(tracker.syncToken).toBe(0)
    expect(tracker.baseUrl).toBe('http://example.com') // baseUrl 不被 reset 影响
  })

  it('状态独立于其他 tracker', () => {
    const tracker1 = createConnectionTracker()
    const tracker2 = createConnectionTracker()

    tracker1.markConnected()
    tracker1.updateBaseUrl('http://example1.com')

    expect(tracker1.isFirstConnect).toBe(false)
    expect(tracker1.syncToken).toBe(1)
    expect(tracker1.baseUrl).toBe('http://example1.com')

    expect(tracker2.isFirstConnect).toBe(true)
    expect(tracker2.syncToken).toBe(0)
    expect(tracker2.baseUrl).toBe('')
  })
})

describe('createBaseUrlChangeHandler', () => {
  it('baseUrl 未改变时不执行任何操作', () => {
    const baseUrlRef = { current: 'http://example.com' }
    const isFirstConnectRef = { current: false }
    const syncTokenRef = { current: 5 }
    const queryClient = { clear: vi.fn() }

    const handler = createBaseUrlChangeHandler(
      baseUrlRef,
      isFirstConnectRef,
      syncTokenRef,
      queryClient as any
    )

    handler('http://example.com')

    expect(baseUrlRef.current).toBe('http://example.com')
    expect(isFirstConnectRef.current).toBe(false)
    expect(syncTokenRef.current).toBe(5)
    expect(queryClient.clear).not.toHaveBeenCalled()
  })

  it('baseUrl 改变时重置状态并清理 queryClient', () => {
    const baseUrlRef = { current: 'http://example.com' }
    const isFirstConnectRef = { current: false }
    const syncTokenRef = { current: 5 }
    const queryClient = { clear: vi.fn() }

    const handler = createBaseUrlChangeHandler(
      baseUrlRef,
      isFirstConnectRef,
      syncTokenRef,
      queryClient as any
    )

    handler('http://new-example.com')

    expect(baseUrlRef.current).toBe('http://new-example.com')
    expect(isFirstConnectRef.current).toBe(true)
    expect(syncTokenRef.current).toBe(0)
    expect(queryClient.clear).toHaveBeenCalledTimes(1)
  })

  it('从空字符串到有值时触发重置', () => {
    const baseUrlRef = { current: '' }
    const isFirstConnectRef = { current: false }
    const syncTokenRef = { current: 3 }
    const queryClient = { clear: vi.fn() }

    const handler = createBaseUrlChangeHandler(
      baseUrlRef,
      isFirstConnectRef,
      syncTokenRef,
      queryClient as any
    )

    handler('http://example.com')

    expect(baseUrlRef.current).toBe('http://example.com')
    expect(isFirstConnectRef.current).toBe(true)
    expect(syncTokenRef.current).toBe(0)
    expect(queryClient.clear).toHaveBeenCalledTimes(1)
  })

  it('多次调用相同 baseUrl 只重置一次', () => {
    const baseUrlRef = { current: 'http://example.com' }
    const isFirstConnectRef = { current: false }
    const syncTokenRef = { current: 5 }
    const queryClient = { clear: vi.fn() }

    const handler = createBaseUrlChangeHandler(
      baseUrlRef,
      isFirstConnectRef,
      syncTokenRef,
      queryClient as any
    )

    handler('http://new-example.com')
    handler('http://new-example.com')
    handler('http://new-example.com')

    expect(queryClient.clear).toHaveBeenCalledTimes(1)
  })
})
