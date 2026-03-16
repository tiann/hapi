import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { usePushNotificationsFirstTime } from './pushNotificationsHandler'

describe('usePushNotificationsFirstTime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('当 api 或 token 为 null 时不执行', () => {
    const requestPermission = vi.fn()
    const subscribe = vi.fn()

    renderHook(() =>
      usePushNotificationsFirstTime({
        api: null,
        token: null,
        isPushSupported: true,
        pushPermission: 'default',
        requestPermission,
        subscribe
      })
    )

    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('当 isPushSupported 为 false 时不执行', () => {
    const requestPermission = vi.fn()
    const subscribe = vi.fn()

    renderHook(() =>
      usePushNotificationsFirstTime({
        api: {} as any,
        token: 'test-token',
        isPushSupported: false,
        pushPermission: 'default',
        requestPermission,
        subscribe
      })
    )

    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('当 pushPermission 为 granted 时直接订阅', async () => {
    const requestPermission = vi.fn()
    const subscribe = vi.fn().mockResolvedValue(true)

    renderHook(() =>
      usePushNotificationsFirstTime({
        api: {} as any,
        token: 'test-token',
        isPushSupported: true,
        pushPermission: 'granted',
        requestPermission,
        subscribe
      })
    )

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1)
    })
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('当 pushPermission 为 default 时请求权限', async () => {
    const requestPermission = vi.fn().mockResolvedValue(false)
    const subscribe = vi.fn()

    renderHook(() =>
      usePushNotificationsFirstTime({
        api: {} as any,
        token: 'test-token',
        isPushSupported: true,
        pushPermission: 'default',
        requestPermission,
        subscribe
      })
    )

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
    })
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('当权限被授予时订阅', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn().mockResolvedValue(true)

    renderHook(() =>
      usePushNotificationsFirstTime({
        api: {} as any,
        token: 'test-token',
        isPushSupported: true,
        pushPermission: 'default',
        requestPermission,
        subscribe
      })
    )

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
      expect(subscribe).toHaveBeenCalledTimes(1)
    })
  })

  it('当 pushPermission 为 denied 时不执行任何操作', () => {
    const requestPermission = vi.fn()
    const subscribe = vi.fn()

    renderHook(() =>
      usePushNotificationsFirstTime({
        api: {} as any,
        token: 'test-token',
        isPushSupported: true,
        pushPermission: 'denied',
        requestPermission,
        subscribe
      })
    )

    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('只执行一次，即使重新渲染', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn().mockResolvedValue(true)

    const { rerender } = renderHook(() =>
      usePushNotificationsFirstTime({
        api: {} as any,
        token: 'test-token',
        isPushSupported: true,
        pushPermission: 'default',
        requestPermission,
        subscribe
      })
    )

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
    })

    rerender()
    rerender()
    rerender()

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('当 api 和 token 变为 null 时重置状态', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true)
    const subscribe = vi.fn().mockResolvedValue(true)

    const { rerender } = renderHook(
      ({ api, token }) =>
        usePushNotificationsFirstTime({
          api,
          token,
          isPushSupported: true,
          pushPermission: 'default',
          requestPermission,
          subscribe
        }),
      {
        initialProps: {
          api: {} as any,
          token: 'test-token'
        }
      }
    )

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
    })

    // 重置为 null
    rerender({ api: null, token: null as any })

    // 再次设置
    rerender({ api: {} as any, token: 'new-token' })

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(2)
    })
  })

  it('subscribe 失败时不抛出错误', async () => {
    const requestPermission = vi.fn()
    const subscribe = vi.fn().mockResolvedValue(false)

    expect(() => {
      renderHook(() =>
        usePushNotificationsFirstTime({
          api: {} as any,
          token: 'test-token',
          isPushSupported: true,
          pushPermission: 'granted',
          requestPermission,
          subscribe
        })
      )
    }).not.toThrow()

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(1)
    })
  })

  it('requestPermission 失败时不抛出错误', async () => {
    const requestPermission = vi.fn().mockResolvedValue(false)
    const subscribe = vi.fn()

    expect(() => {
      renderHook(() =>
        usePushNotificationsFirstTime({
          api: {} as any,
          token: 'test-token',
          isPushSupported: true,
          pushPermission: 'default',
          requestPermission,
          subscribe
        })
      )
    }).not.toThrow()

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
    })
    expect(subscribe).not.toHaveBeenCalled()
  })
})
