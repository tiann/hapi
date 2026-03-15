/**
 * 连接状态管理工具
 */

export interface ConnectionManagerOptions {
  isFirstConnect: boolean
  baseUrl: string
  onFirstConnectChange: (isFirst: boolean) => void
}

/**
 * 当 baseUrl 改变时重置连接状态
 */
export function createBaseUrlChangeHandler(
  baseUrlRef: React.MutableRefObject<string>,
  isFirstConnectRef: React.MutableRefObject<boolean>,
  syncTokenRef: React.MutableRefObject<number>,
  queryClient: ReturnType<typeof import('@tanstack/react-query').useQueryClient>
) {
  return (baseUrl: string) => {
    if (baseUrlRef.current === baseUrl) {
      return
    }
    baseUrlRef.current = baseUrl
    isFirstConnectRef.current = true
    syncTokenRef.current = 0
    queryClient.clear()
  }
}

/**
 * 创建连接状态追踪
 */
export function createConnectionTracker() {
  const state = {
    isFirstConnect: true,
    syncToken: 0,
    baseUrl: ''
  }

  return {
    get isFirstConnect() { return state.isFirstConnect },
    get syncToken() { return state.syncToken },
    get baseUrl() { return state.baseUrl },

    markConnected() {
      state.isFirstConnect = false
      state.syncToken += 1
    },

    updateBaseUrl(baseUrl: string) {
      state.baseUrl = baseUrl
    },

    reset() {
      state.isFirstConnect = true
      state.syncToken = 0
    }
  }
}
