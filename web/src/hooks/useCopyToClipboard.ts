import { useState, useCallback } from 'react'
import { usePlatform } from './usePlatform'
import { safeCopyToClipboard } from '@/lib/clipboard'

export function useCopyToClipboard(resetDelay = 1500) {
    const [copied, setCopied] = useState(false)
    const { haptic } = usePlatform()

    const copy = useCallback(async (text: string) => {
        try {
            await safeCopyToClipboard(text)
            haptic.notification('success')
            setCopied(true)
            setTimeout(() => setCopied(false), resetDelay)
            return true
        } catch {
            haptic.notification('error')
            return false
        }
    }, [haptic, resetDelay])

    return { copied, copy }
}
