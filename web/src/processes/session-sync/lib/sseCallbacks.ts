/**
 * SSE 连接回调处理
 */

import type { ApiClient } from '@/api/client'
import type { SyncEvent } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { fetchLatestMessages } from '@/lib/message-window-store'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

export interface SseCallbacksOptions {
  queryClient: ReturnType<typeof import('@tanstack/react-query').useQueryClient>
  startSync: () => void
  endSync: () => void
  addToast: (toast: {
    title: string
    body?: string
    sessionId?: string
    url?: string
  }) => void
  api: ApiClient | null
  selectedSessionId: string | null
}

/**
 * 创建 SSE 连接成功回调
 */
export function createSseConnectHandler(options: SseCallbacksOptions) {
  const {
    queryClient,
    startSync,
    endSync,
    api,
    selectedSessionId
  } = options

  let currentSyncToken = 0

  return () => {
    const syncToken = ++currentSyncToken

    // 首次连接使用强制模式显示 banner
    const isFirstConnect = syncToken === 1
    startSync()

    const invalidations = [
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
      ...(selectedSessionId ? [
        queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) })
      ] : [])
    ]

    const refreshMessages = (selectedSessionId && api)
      ? fetchLatestMessages(api, selectedSessionId)
      : Promise.resolve()

    Promise.all([...invalidations, refreshMessages])
      .catch((error) => {
        console.error('Failed to invalidate queries on SSE connect:', error)
      })
      .finally(() => {
        // 只有当前连接是最新的时才结束同步
        if (currentSyncToken === syncToken) {
          endSync()
        }
      })
  }
}

/**
 * 创建 SSE 断开连接回调
 */
export function createSseDisconnectHandler(
  isFirstConnectRef: React.MutableRefObject<boolean>,
  setSseDisconnected: (disconnected: boolean) => void,
  setSseDisconnectReason: (reason: string | null) => void
) {
  return (reason: string) => {
    // 只有在已经连接过一次后才显示重连 banner
    if (!isFirstConnectRef.current) {
      setSseDisconnected(true)
      setSseDisconnectReason(reason)
    }
  }
}

/**
 * 创建 SSE 空事件回调
 */
export function createSseEventHandler() {
  return () => {
    // 预留用于处理通用 SSE 事件
  }
}

/**
 * 创建 SSE Toast 事件回调
 */
export function createToastHandler(
  addToast: (toast: {
    title: string
    body?: string
    sessionId?: string
    url?: string
  }) => void
) {
  return (event: ToastEvent) => {
    addToast({
      title: event.data.title,
      body: event.data.body,
      sessionId: event.data.sessionId,
      url: event.data.url
    })
  }
}
