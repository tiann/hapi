import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAuthBootstrap } from './hooks'

// Mock dependencies
vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn()
}))

vi.mock('@/entities/auth', () => ({
  useServerUrl: vi.fn(),
  useAuthSource: vi.fn(),
  useAuth: vi.fn()
}))

vi.mock('../lib/urlCleaner', () => ({
  cleanAuthParams: vi.fn()
}))

import { useRouter } from '@tanstack/react-router'
import { useServerUrl, useAuthSource, useAuth } from '@/entities/auth'
import { cleanAuthParams } from '../lib/urlCleaner'

describe('useAuthBootstrap', () => {
  const mockRouter = {
    history: {
      location: {
        pathname: '/sessions',
        search: '',
        hash: '',
        state: null
      },
      replace: vi.fn()
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(useRouter as any).mockReturnValue(mockRouter)
    // 默认 cleanAuthParams 返回不需要清理
    ;(cleanAuthParams as any).mockReturnValue({
      shouldClean: false,
      nextHref: ''
    })
  })

  it('初始化时返回正确的状态', () => {
    ;(useServerUrl as any).mockReturnValue({
      serverUrl: '',
      baseUrl: '',
      setServerUrl: vi.fn(),
      clearServerUrl: vi.fn()
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: null,
      isLoading: true,
      setAccessToken: vi.fn()
    })
    ;(useAuth as any).mockReturnValue({
      token: null,
      api: null,
      isLoading: true,
      error: null
    })

    const { result } = renderHook(() => useAuthBootstrap())

    expect(result.current.serverUrl).toBe('')
    expect(result.current.baseUrl).toBe('')
    expect(result.current.authSource).toBe(null)
    expect(result.current.token).toBe(null)
    expect(result.current.api).toBe(null)
    expect(result.current.isReady).toBe(false)
  })

  it('authSource 加载完成后 isReady 为 true', () => {
    ;(useServerUrl as any).mockReturnValue({
      serverUrl: 'http://example.com',
      baseUrl: 'http://example.com',
      setServerUrl: vi.fn(),
      clearServerUrl: vi.fn()
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: { type: 'cli', token: 'test-token' },
      isLoading: false,
      setAccessToken: vi.fn()
    })
    ;(useAuth as any).mockReturnValue({
      token: 'test-token',
      api: {},
      isLoading: false,
      error: null
    })

    const { result } = renderHook(() => useAuthBootstrap())

    expect(result.current.isReady).toBe(true)
  })

  it('认证成功后清理 URL 参数', async () => {
    const mockReplace = vi.fn()
    ;(useRouter as any).mockReturnValue({
      history: {
        location: {
          pathname: '/sessions',
          search: '?server=http://example.com&token=abc123',
          hash: '',
          state: null
        },
        replace: mockReplace
      }
    })
    ;(useServerUrl as any).mockReturnValue({
      serverUrl: 'http://example.com',
      baseUrl: 'http://example.com',
      setServerUrl: vi.fn(),
      clearServerUrl: vi.fn()
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: { type: 'cli', token: 'test-token' },
      isLoading: false,
      setAccessToken: vi.fn()
    })
    ;(useAuth as any).mockReturnValue({
      token: 'test-token',
      api: {},
      isLoading: false,
      error: null
    })
    ;(cleanAuthParams as any).mockReturnValue({
      shouldClean: true,
      nextHref: '/sessions'
    })

    renderHook(() => useAuthBootstrap())

    await waitFor(() => {
      expect(cleanAuthParams).toHaveBeenCalledWith({
        pathname: '/sessions',
        search: '?server=http://example.com&token=abc123',
        hash: '',
        state: null
      })
      expect(mockReplace).toHaveBeenCalledWith('/sessions', null)
    })
  })

  it('URL 参数不需要清理时不调用 replace', async () => {
    const mockReplace = vi.fn()
    ;(useRouter as any).mockReturnValue({
      history: {
        location: {
          pathname: '/sessions',
          search: '',
          hash: '',
          state: null
        },
        replace: mockReplace
      }
    })
    ;(useServerUrl as any).mockReturnValue({
      serverUrl: 'http://example.com',
      baseUrl: 'http://example.com',
      setServerUrl: vi.fn(),
      clearServerUrl: vi.fn()
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: { type: 'cli', token: 'test-token' },
      isLoading: false,
      setAccessToken: vi.fn()
    })
    ;(useAuth as any).mockReturnValue({
      token: 'test-token',
      api: {},
      isLoading: false,
      error: null
    })
    ;(cleanAuthParams as any).mockReturnValue({
      shouldClean: false,
      nextHref: ''
    })

    renderHook(() => useAuthBootstrap())

    await waitFor(() => {
      expect(cleanAuthParams).toHaveBeenCalled()
    })

    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('token 或 api 为 null 时不清理 URL', () => {
    const mockReplace = vi.fn()
    ;(useRouter as any).mockReturnValue({
      history: {
        location: {
          pathname: '/sessions',
          search: '?server=http://example.com',
          hash: '',
          state: null
        },
        replace: mockReplace
      }
    })
    ;(useServerUrl as any).mockReturnValue({
      serverUrl: 'http://example.com',
      baseUrl: 'http://example.com',
      setServerUrl: vi.fn(),
      clearServerUrl: vi.fn()
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: { type: 'cli', token: 'test-token' },
      isLoading: false,
      setAccessToken: vi.fn()
    })
    ;(useAuth as any).mockReturnValue({
      token: null,
      api: null,
      isLoading: true,
      error: null
    })

    renderHook(() => useAuthBootstrap())

    expect(cleanAuthParams).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('返回所有必要的状态和方法', () => {
    const mockSetServerUrl = vi.fn()
    const mockClearServerUrl = vi.fn()
    const mockSetAccessToken = vi.fn()

    ;(useServerUrl as any).mockReturnValue({
      serverUrl: 'http://example.com',
      baseUrl: 'http://example.com',
      setServerUrl: mockSetServerUrl,
      clearServerUrl: mockClearServerUrl
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: { type: 'cli', token: 'test-token' },
      isLoading: false,
      setAccessToken: mockSetAccessToken
    })
    ;(useAuth as any).mockReturnValue({
      token: 'test-token',
      api: { baseUrl: 'http://example.com' },
      isLoading: false,
      error: null
    })

    const { result } = renderHook(() => useAuthBootstrap())

    expect(result.current.serverUrl).toBe('http://example.com')
    expect(result.current.baseUrl).toBe('http://example.com')
    expect(result.current.setServerUrl).toBe(mockSetServerUrl)
    expect(result.current.clearServerUrl).toBe(mockClearServerUrl)
    expect(result.current.authSource).toEqual({ type: 'cli', token: 'test-token' })
    expect(result.current.token).toBe('test-token')
    expect(result.current.api).toEqual({ baseUrl: 'http://example.com' })
    expect(result.current.setAccessToken).toBe(mockSetAccessToken)
    expect(result.current.isReady).toBe(true)
  })

  it('处理认证错误', () => {
    ;(useServerUrl as any).mockReturnValue({
      serverUrl: 'http://example.com',
      baseUrl: 'http://example.com',
      setServerUrl: vi.fn(),
      clearServerUrl: vi.fn()
    })
    ;(useAuthSource as any).mockReturnValue({
      authSource: { type: 'cli', token: 'test-token' },
      isLoading: false,
      setAccessToken: vi.fn()
    })
    ;(useAuth as any).mockReturnValue({
      token: null,
      api: null,
      isLoading: false,
      error: new Error('Auth failed')
    })

    const { result } = renderHook(() => useAuthBootstrap())

    expect(result.current.authError).toEqual(new Error('Auth failed'))
    expect(result.current.token).toBe(null)
    expect(result.current.api).toBe(null)
  })
})
