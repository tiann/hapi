/**
 * 推送通知首次订阅处理
 */

import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'

export interface PushNotificationsOptions {
  api: ApiClient | null
  token: string | null
  isPushSupported: boolean
  pushPermission: NotificationPermission
  requestPermission: () => Promise<boolean>
  subscribe: () => Promise<boolean>
}

/**
 * 管理推送通知的首次授权和订阅
 * 只在认证成功后执行一次
 */
export function usePushNotificationsFirstTime(options: PushNotificationsOptions) {
  const {
    api,
    token,
    isPushSupported,
    pushPermission,
    requestPermission,
    subscribe
  } = options

  const pushPromptedRef = useRef(false)

  useEffect(() => {
    if (!api || !token) {
      pushPromptedRef.current = false
      return
    }
    if (!isPushSupported) {
      return
    }
    if (pushPromptedRef.current) {
      return
    }
    pushPromptedRef.current = true

    const run = async () => {
      if (pushPermission === 'granted') {
        await subscribe()
        return
      }
      if (pushPermission === 'default') {
        const granted = await requestPermission()
        if (granted) {
          await subscribe()
        }
      }
    }

    void run()
  }, [api, token, isPushSupported, pushPermission, requestPermission, subscribe])
}
