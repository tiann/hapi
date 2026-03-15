import { describe, expect, it, vi } from 'vitest'
import {
  createSseConnectHandler,
  createSseDisconnectHandler,
  createSseEventHandler,
  createToastHandler
} from './sseCallbacks'

describe('createSseConnectHandler', () => {
  it('调用 startSync 并触发 query invalidation', async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined)
    }
    const startSync = vi.fn()
    const endSync = vi.fn()
    const addToast = vi.fn()

    const handler = createSseConnectHandler({
      queryClient: queryClient as any,
      startSync,
      endSync,
      addToast,
      api: null,
      selectedSessionId: null
    })

    handler()

    expect(startSync).toHaveBeenCalledTimes(1)

    // 等待异步操作完成
    await vi.waitFor(() => {
      expect(endSync).toHaveBeenCalledTimes(1)
    })
  })

  it('当有 selectedSessionId 时 invalidate 会话详情', async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined)
    }
    const startSync = vi.fn()
    const endSync = vi.fn()
    const addToast = vi.fn()

    const handler = createSseConnectHandler({
      queryClient: queryClient as any,
      startSync,
      endSync,
      addToast,
      api: null,
      selectedSessionId: 'session-123'
    })

    handler()

    await vi.waitFor(() => {
      expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
    })
  })

  it('invalidation 失败时仍然调用 endSync', async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockRejectedValue(new Error('Network error'))
    }
    const startSync = vi.fn()
    const endSync = vi.fn()
    const addToast = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const handler = createSseConnectHandler({
      queryClient: queryClient as any,
      startSync,
      endSync,
      addToast,
      api: null,
      selectedSessionId: null
    })

    handler()

    await vi.waitFor(() => {
      expect(endSync).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalled()
    })

    consoleError.mockRestore()
  })

  it('多次调用使用不同的 syncToken', async () => {
    const queryClient = {
      invalidateQueries: vi.fn().mockResolvedValue(undefined)
    }
    const startSync = vi.fn()
    const endSync = vi.fn()
    const addToast = vi.fn()

    const handler = createSseConnectHandler({
      queryClient: queryClient as any,
      startSync,
      endSync,
      addToast,
      api: null,
      selectedSessionId: null
    })

    handler()
    await vi.waitFor(() => {
      expect(endSync).toHaveBeenCalledTimes(1)
    })

    handler()
    await vi.waitFor(() => {
      expect(endSync).toHaveBeenCalledTimes(2)
    })

    handler()
    await vi.waitFor(() => {
      expect(endSync).toHaveBeenCalledTimes(3)
    })

    expect(startSync).toHaveBeenCalledTimes(3)
  })
})

describe('createSseDisconnectHandler', () => {
  it('首次连接时不触发断开通知', () => {
    const isFirstConnectRef = { current: true }
    const setSseDisconnected = vi.fn()
    const setSseDisconnectReason = vi.fn()

    const handler = createSseDisconnectHandler(
      isFirstConnectRef,
      setSseDisconnected,
      setSseDisconnectReason
    )

    handler('connection lost')

    expect(setSseDisconnected).not.toHaveBeenCalled()
    expect(setSseDisconnectReason).not.toHaveBeenCalled()
  })

  it('非首次连接时触发断开通知', () => {
    const isFirstConnectRef = { current: false }
    const setSseDisconnected = vi.fn()
    const setSseDisconnectReason = vi.fn()

    const handler = createSseDisconnectHandler(
      isFirstConnectRef,
      setSseDisconnected,
      setSseDisconnectReason
    )

    handler('connection lost')

    expect(setSseDisconnected).toHaveBeenCalledWith(true)
    expect(setSseDisconnectReason).toHaveBeenCalledWith('connection lost')
  })

  it('传递正确的断开原因', () => {
    const isFirstConnectRef = { current: false }
    const setSseDisconnected = vi.fn()
    const setSseDisconnectReason = vi.fn()

    const handler = createSseDisconnectHandler(
      isFirstConnectRef,
      setSseDisconnected,
      setSseDisconnectReason
    )

    handler('network error')

    expect(setSseDisconnectReason).toHaveBeenCalledWith('network error')
  })
})

describe('createSseEventHandler', () => {
  it('返回空函数', () => {
    const handler = createSseEventHandler()

    expect(handler).toBeInstanceOf(Function)
    expect(() => handler()).not.toThrow()
  })
})

describe('createToastHandler', () => {
  it('调用 addToast 并传递事件数据', () => {
    const addToast = vi.fn()
    const handler = createToastHandler(addToast)

    const event = {
      type: 'toast' as const,
      data: {
        title: 'Test Title',
        body: 'Test Body',
        sessionId: 'session-123',
        url: 'http://example.com'
      }
    }

    handler(event)

    expect(addToast).toHaveBeenCalledWith({
      title: 'Test Title',
      body: 'Test Body',
      sessionId: 'session-123',
      url: 'http://example.com'
    })
  })

  it('处理没有 body 的 toast', () => {
    const addToast = vi.fn()
    const handler = createToastHandler(addToast)

    const event = {
      type: 'toast' as const,
      data: {
        title: 'Test Title'
      }
    }

    handler(event)

    expect(addToast).toHaveBeenCalledWith({
      title: 'Test Title',
      body: undefined,
      sessionId: undefined,
      url: undefined
    })
  })

  it('处理完整的 toast 数据', () => {
    const addToast = vi.fn()
    const handler = createToastHandler(addToast)

    const event = {
      type: 'toast' as const,
      data: {
        title: 'New Message',
        body: 'You have a new message',
        sessionId: 'session-456',
        url: '/sessions/session-456'
      }
    }

    handler(event)

    expect(addToast).toHaveBeenCalledWith({
      title: 'New Message',
      body: 'You have a new message',
      sessionId: 'session-456',
      url: '/sessions/session-456'
    })
  })
})
