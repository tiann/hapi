import { useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { useLongPress } from '@/hooks/useLongPress'
import type { AnchoredMenuPoint } from '@/hooks/useAnchoredMenu'

/**
 * Open a file's action menu from a row: right-click on desktop (native
 * `contextmenu`) and long-press on mobile, while keeping tap / Enter as the
 * normal open action. Returns handlers to spread onto the row (or its primary
 * button).
 */
export function useFileMenuTrigger(options: {
    onOpen: () => void
    onOpenMenu?: (point: AnchoredMenuPoint) => void
}) {
    const { onOpen, onOpenMenu } = options
    const longPress = useLongPress({
        onLongPress: (point) => onOpenMenu?.(point),
        onClick: onOpen,
        interaction: 'touch-only-native-click',
        longPressEnabled: Boolean(onOpenMenu),
    })
    const onContextMenu = onOpenMenu
        ? (event: ReactMouseEvent<HTMLElement>) => {
            event.preventDefault()
            onOpenMenu({ x: event.clientX, y: event.clientY })
        }
        : undefined

    return { ...longPress, onContextMenu }
}
