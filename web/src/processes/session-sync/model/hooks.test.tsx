import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSessionSync } from './hooks'
import type { UseSessionSyncOptions } from './hooks'

// Mock dependencies
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: vi.fn()
}))

vi.mock('@/hooks/useSSE', () => ({
  useSSE: vi.fn()
}))

vi.mock('@/hooks/useSyncingState', () => ({
  useSyncingState: vi.fn()
}))

vi.mock('@/hooks/useVisibilityReporter', () => ({
  useVisibilityReporter: vi.fn()
}))

vi.mock('@/hooks/usePushNotifications', () => ({
  usePushNotifications: vi.fn()
}))

vi.mock('../lib/subscriptionBuilder', () => ({
  buildEventSubscription: vi.fn(),
  getSubscriptionKey: vi.fn()
}))

vi.mock('../lib/pushNotificationsHandler', () => ({
  usePushNotificationsFirstTime: vi.fn()
}))

import { useQueryClient } from '@tanstack/react-query'
import { useSSE } from '@/hooks/useSSE'
import { useSyncingState } from '@/hooks/useSyncingState'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { buildEventSubscription } from '../lib/subscriptionBuilder'
import { usePushNotificationsFirstTime } from '../lib/pushNotificationsHandler'

describe('useSessionSync', () => {
  const mockQueryClient = {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn()
  }

  const mockStartSync = vi.fn()
  const mockEndSync = vi.fn()
  const mockAddToast = vi.fn()

  const defaultOptions: UseSessionSyncOptions = {
    enabled: true,
    token: 'test-token',
    baseUrl: 'http://example.com',
    selectedSessionId: null,
    api: {} as any,
    addToast: mockAddToast
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useQueryClient as any).mockReturnValue(mockQueryClient)
    ;(useSyncingState as any).mockReturnValue({
      isSyncing: false,
      startSync: mockStartSync,
      endSync: mockEndSync
    })
    ;(useSSE as any).mockReturnValue({
      subscriptionId: 'sub-123'
    })
    ;(useVisibilityReporter as any).mockReturnValue(undefined)
    ;(usePushNotifications as any).mockReturnValue({
      isSupported: true,
      permission: 'default',
      requestPermission: vi.fn(),
      subscribe: vi.fn()
    })
    ;(usePushNotificationsFirstTime as any).mockReturnValue(undefined)
    ;(buildEventSubscription as any).mockReturnValue({ all: true })
  })

  it('初始化时返回正确的状态', () => {
    const { result } = renderHook(() => useSessionSync(defaultOptions))

    expect(result.current.isSyncing).toBe(false)
    expect(result.current.sseDisconnected).toBe(false)
    expect(result.current.sseDisconnectReason).toBe(null)
    expect(result.current.subscriptionId).toBe('sub-123')
  })

  it('启用 SSE 连接', () => {
    renderHook(() => useSessionSync(defaultOptions))

    expect(useSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        token: 'test-token',
        baseUrl: 'http://example.com',
        subscription: { all: true }
      })
    )
  })

  it('当 selectedSessionId 存在时构建会话订阅', () => {
    ;(buildEventSubscription as any).mockReturnValue({ sessionId: 'session-123' })

    renderHook(() =>
      useSessionSync({
        ...defaultOptions,
        selectedSessionId: 'session-123'
      })
    )

    expect(buildEventSubscription).toHaveBeenCalledWith('session-123')
  })

  it('SSE 连接成功时触发 query invalidation', async () => {
    let onConnectCallback: (() => void) | undefined

    ;(useSSE as any).mockImplementation((options: any) => {
      onConnectCallback = options.onConnect
      return { subscriptionId: 'sub-123' }
    })

    renderHook(() => useSessionSync(defaultOptions))

    expect(onConnectCallback).toBeDefined()

    // 触发连接回调
    onConnectCallback!()

    expect(mockStartSync).toHaveBeenCalled()

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['sessions']
      })
      expect(mockEndSync).toHaveBeenCalled()
    })
  })

  it('SSE 连接成功时如果有 selectedSessionId 则 invalidate 会话详情', async () => {
    let onConnectCallback: (() => void) | undefined

    ;(useSSE as any).mockImplementation((options: any) => {
      onConnectCallback = options.onConnect
      return { subscriptionId: 'sub-123' }
    })

    renderHook(() =>
      useSessionSync({
        ...defaultOptions,
        selectedSessionId: 'session-123'
      })
    )

    onConnectCallback!()

    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['session', 'session-123']
      })
    })
  })

  it('SSE 断开连接时更新状态', () => {
    let onDisconnectCallback: ((reason: string) => void) | undefined

    ;(useSSE as any).mockImplementation((options: any) => {
      onDisconnectCallback = options.onDisconnect
      return { subscriptionId: 'sub-123' }
    })

    const { result } = renderHook(() => useSessionSync(defaultOptions))

    expect(onDisconnectCallback).toBeDefined()

    // 首次连接时不应该显示断开状态
    onDisconnectCallback!('network-error')
    expect(result.current.sseDisconnected).toBe(false)
  })

  it('Toast 事件触发 addToast', () => {
    let onToastCallback: ((event: any) => void) | undefined

    ;(useSSE as any).mockImplementation((options: any) => {
      onToastCallback = options.onToast
      return { subscriptionId: 'sub-123' }
    })

    renderHook(() => useSessionSync(defaultOptions))

    expect(onToastCallback).toBeDefined()

    const toastEvent = {
      type: 'toast',
      data: {
        title: 'Test Toast',
        body: 'Test Body',
        sessionId: 'session-123',
        url: '/test'
      }
    }

    onToastCallback!(toastEvent)

    expect(mockAddToast).toHaveBeenCalledWith({
      title: 'Test Toast',
      body: 'Test Body',
      sessionId: 'session-123',
      url: '/test'
    })
  })

  it('baseUrl 改变时清理 queryClient', () => {
    const { rerender } = renderHook(
      ({ baseUrl }) => useSessionSync({ ...defaultOptions, baseUrl }),
      { initialProps: { baseUrl: 'http://example.com' } }
    )

    expect(mockQueryClient.clear).not.toHaveBeenCalled()

    // 改变 baseUrl
    rerender({ baseUrl: 'http://new-example.com' })

    expect(mockQueryClient.clear).toHaveBeenCalledTimes(1)
  })

  it('baseUrl 不变时不清理 queryClient', () => {
    const { rerender } = renderHook(
      ({ baseUrl }) => useSessionSync({ ...defaultOptions, baseUrl }),
      { initialProps: { baseUrl: 'http://example.com' } }
    )

    rerender({ baseUrl: 'http://example.com' })
    rerender({ baseUrl: 'http://example.com' })

    expect(mockQueryClient.clear).not.toHaveBeenCalled()
  })

  it('调用 useVisibilityReporter', () => {
    renderHook(() => useSessionSync(defaultOptions))

    expect(useVisibilityReporter).toHaveBeenCalledWith({
      api: defaultOptions.api,
      subscriptionId: 'sub-123',
      enabled: true
    })
  })

  it('调用 usePushNotifications', () => {
    renderHook(() => useSessionSync(defaultOptions))

    expect(usePushNotifications).toHaveBeenCalledWith(defaultOptions.api)
  })

  it('调用 usePushNotificationsFirstTime', () => {
    const mockRequestPermission = vi.fn()
    const mockSubscribe = vi.fn()

    ;(usePushNotifications as any).mockReturnValue({
      isSupported: true,
      permission: 'default',
      requestPermission: mockRequestPermission,
      subscribe: mockSubscribe
    })

    renderHook(() => useSessionSync(defaultOptions))

    expect(usePushNotificationsFirstTime).toHaveBeenCalledWith({
      api: defaultOptions.api,
      token: 'test-token',
      isPushSupported: true,
      pushPermission: 'default',
      requestPermission: mockRequestPermission,
      subscribe: mockSubscribe
    })
  })

  it('enabled 为 false 时不启用 SSE', () => {
    renderHook(() =>
      useSessionSync({
        ...defaultOptions,
        enabled: false
      })
    )

    expect(useSSE).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false
      })
    )
  })

  it('invalidation 失败时仍然调用 endSync', async () => {
    let onConnectCallback: (() => void) | undefined

    mockQueryClient.invalidateQueries.mockRejectedValue(new Error('Network error'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    ;(useSSE as any).mockImplementation((options: any) => {
      onConnectCallback = options.onConnect
      return { subscriptionId: 'sub-123' }
    })

    renderHook(() => useSessionSync(defaultOptions))

    onConnectCallback!()

    await waitFor(() => {
      expect(mockEndSync).toHaveBeenCalled()
    })

    consoleError.mockRestore()
  })

  it('返回 startSync 和 endSync 方法', () => {
    const { result } = renderHook(() => useSessionSync(defaultOptions))

    expect(typeof result.current.startSync).toBe('function')
    expect(typeof result.current.endSync).toBe('function')
  })
})
