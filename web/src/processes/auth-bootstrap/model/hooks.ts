import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useAuth, useAuthSource, useServerUrl } from '@/entities/auth'
import { cleanAuthParams } from '../lib/urlCleaner'

/**
 * 认证初始化流程 Hook
 *
 * 负责：
 * 1. Server URL 管理（从 URL 参数或 localStorage 读取）
 * 2. Auth Source 初始化（检测环境、读取 token）
 * 3. Token 建立（使用 auth source 获取 access token）
 * 4. URL 参数清理（认证成功后清理敏感参数）
 */
export function useAuthBootstrap() {
  const router = useRouter()
  const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl()
  const { authSource, isLoading: isAuthSourceLoading, setAccessToken } = useAuthSource(baseUrl)
  const { token, api, isLoading: isAuthLoading, error: authError } = useAuth(authSource, baseUrl)

  // Clean up URL params after successful auth (for direct access links)
  useEffect(() => {
    if (!token || !api) return

    const { pathname, search, hash, state } = router.history.location
    const cleanResult = cleanAuthParams({ pathname, search, hash, state })

    if (cleanResult.shouldClean) {
      router.history.replace(cleanResult.nextHref, state)
    }
  }, [token, api, router])

  return {
    // Server URL 状态
    serverUrl,
    baseUrl,
    setServerUrl,
    clearServerUrl,

    // Auth 状态
    authSource,
    isAuthSourceLoading,
    token,
    api,
    isAuthLoading,
    authError,
    setAccessToken,

    // 是否已完成初始化（authSource 已加载）
    isReady: !isAuthSourceLoading
  }
}
