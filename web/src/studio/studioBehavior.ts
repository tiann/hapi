import type { PublicStudioMessage } from '@/types/api'

export const STUDIO_NEAR_BOTTOM_PX = 120
export const STUDIO_COLLAPSE_CHAR_THRESHOLD = 700
export const STUDIO_COLLAPSE_LINE_THRESHOLD = 12

export function isStudioNearBottom(
    metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
    threshold = STUDIO_NEAR_BOTTOM_PX
): boolean {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

export function countNewStudioMessages(
    previousLastId: string | null,
    messages: readonly PublicStudioMessage[]
): number {
    if (!previousLastId || messages.length === 0) return 0
    const previousIndex = messages.findIndex((message) => message.id === previousLastId)
    if (previousIndex < 0) return 1
    return Math.max(0, messages.length - previousIndex - 1)
}

export function shouldCollapseStudioMessage(text: string): boolean {
    if (text.length >= STUDIO_COLLAPSE_CHAR_THRESHOLD) return true
    return text.split(/\r?\n/).length >= STUDIO_COLLAPSE_LINE_THRESHOLD
}

export function shouldAutoJumpOnTabOpen(
    previousTab: 'conversation' | 'discussion',
    nextTab: 'conversation' | 'discussion',
    unreadCount: number
): boolean {
    return previousTab !== 'conversation' && nextTab === 'conversation' && unreadCount > 0
}
