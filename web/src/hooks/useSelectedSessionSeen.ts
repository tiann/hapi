import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { followSessionTail, markRenderedSessionSeen, pendingUnreadId } from '@/lib/sessionLastSeen'
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
): () => void {
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
        type Receipt = { revision: number; version: number | undefined; localUnread: string | undefined }
        let observed: Receipt | undefined
        let ready: Receipt | undefined
        let acknowledged: number | undefined
        const update = () => {
            if (!tailIsVisible(viewport, messages)) {
                stopFollowing?.()
                stopFollowing = undefined
                return
            }
            stopFollowing ??= followSessionTail(sessionId)
            const revision = latest.current.renderedRevision
            if (revision === undefined) return
            if (observed?.revision !== revision) {
                observed = { revision, version: latest.current.stateVersion, localUnread: pendingUnreadId(sessionId) }
            }
            if (ready) {
                const receipt = ready
                ready = undefined
                acknowledged = receipt.revision
                markRenderedSessionSeen(sessionId, receipt.revision, receipt.version, receipt.localUnread)
            }
            if (frame !== undefined || acknowledged === revision) return
            const receipt = observed
            // Wait for committed rows to lay out. Once ready, a temporarily
            // offscreen receipt can finish on the next scroll correction; it
            // does not need another pair of frames to prove the same layout.
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    frame = undefined
                    ready = receipt
                    update()
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
    // Called immediately after an instant pin, even if the browser coalesces
    // its scroll event with the next streaming layout change.
    return useCallback(() => schedule.current?.(), [])
}
