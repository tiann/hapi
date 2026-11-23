import { useEffect, useRef, type RefObject } from 'react'
import { followSessionTail, markSessionSeen } from '@/lib/sessionLastSeen'
import { useDocumentVisibility } from './useDocumentVisibility'

function tailIsVisible(viewport: HTMLElement, messages: HTMLElement): boolean {
    if (document.visibilityState !== 'visible' || viewport.clientHeight <= 0) return false
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2) return true
    // The transcript can be fully visible before the trailing layout padding is.
    const tail = messages.getBoundingClientRect()
    const view = viewport.getBoundingClientRect()
    return tail.height > 0 && tail.bottom > view.top && tail.bottom <= view.bottom
}

/** Called by the rendered transcript, never by list selection or SSE metadata. */
export function useSelectedSessionSeen(
    sessionId: string | null,
    renderedRevision: number | undefined,
    stateVersion: number | undefined,
    viewportRef: RefObject<HTMLElement | null>,
    messagesRef: RefObject<HTMLElement | null>
): void {
    const visible = useDocumentVisibility()
    const enabled = visible && renderedRevision !== undefined
    const latest = useRef({ renderedRevision, stateVersion })
    const schedule = useRef<() => void>(undefined)
    useEffect(() => {
        const changed = latest.current.renderedRevision !== renderedRevision
        latest.current = { renderedRevision, stateVersion }
        // A read-state SSE update alone is not a new viewing action.
        if (changed) schedule.current?.()
    }, [renderedRevision, stateVersion])

    useEffect(() => {
        const viewport = viewportRef.current
        const messages = messagesRef.current
        if (!enabled || !sessionId || !viewport || !messages) return
        let stopFollowing: (() => void) | undefined
        let frame: number | undefined
        let acknowledged: number | undefined
        const update = () => {
            if (!tailIsVisible(viewport, messages)) {
                if (frame !== undefined) cancelAnimationFrame(frame)
                frame = undefined
                stopFollowing?.()
                stopFollowing = undefined
                return
            }
            stopFollowing ??= followSessionTail(sessionId)
            const { renderedRevision: revision, stateVersion: version } = latest.current
            if (frame !== undefined || revision === undefined || acknowledged === revision) return
            // Wait for committed message rows and scroll correction. Coalesce
            // events instead of restarting the wait on every streaming mutation.
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    frame = undefined
                    if (!tailIsVisible(viewport, messages)) { update(); return }
                    acknowledged = revision
                    markSessionSeen(sessionId, revision, version)
                    if (latest.current.renderedRevision !== revision) update()
                })
            })
        }
        schedule.current = update
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
        resize?.observe(viewport)
        resize?.observe(messages)
        const mutations = new MutationObserver(update)
        mutations.observe(messages, { subtree: true, childList: true, characterData: true })
        viewport.addEventListener('scroll', update, { passive: true })
        update()
        return () => {
            schedule.current = undefined
            if (frame !== undefined) cancelAnimationFrame(frame)
            resize?.disconnect()
            mutations.disconnect()
            viewport.removeEventListener('scroll', update)
            stopFollowing?.()
        }
    }, [enabled, sessionId, viewportRef, messagesRef])
}
