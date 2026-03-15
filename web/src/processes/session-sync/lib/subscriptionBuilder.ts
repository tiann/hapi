/**
 * SSE 事件订阅管理
 */

export interface SSESubscription {
  all?: boolean
  sessionId?: string
  machineId?: string
}

/**
 * 根据 sessionId 构建 SSE 订阅对象
 */
export function buildEventSubscription(selectedSessionId: string | null): SSESubscription {
  if (selectedSessionId) {
    return { sessionId: selectedSessionId }
  }
  return { all: true }
}

/**
 * 生成订阅键，用于 useEffect 依赖
 */
export function getSubscriptionKey(subscription: SSESubscription): string {
  return `${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
}
