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
        type Receipt = { revision: number; version: number | undefined; localUnread: string | undefined }
        let scheduledRevision: number | undefined
        let ready: Receipt | undefined
        const frames = new Set<number>()
        const nextFrame = (callback: () => void) => {
            const frame = requestAnimationFrame(() => { frames.delete(frame); callback() })
            frames.add(frame)
        }
        const update = () => {
            if (!tailIsVisible(viewport, messages)) {
                stopFollowing?.()
                stopFollowing = undefined
                return
            }
            stopFollowing ??= followSessionTail(sessionId)
            const revision = latest.current.renderedRevision
            if (revision === undefined) return
            if (ready) {
                const receipt = ready
                ready = undefined
                markRenderedSessionSeen(sessionId, receipt.revision, receipt.version, receipt.localUnread)
            }
            if (scheduledRevision === revision) return
            scheduledRevision = revision
            const receipt = { revision, version: latest.current.stateVersion, localUnread: pendingUnreadId(sessionId) }
            // Each rendered revision matures after its own two frames. Layout
            // events never restart that wait or serialize successive revisions.
            nextFrame(() => nextFrame(() => {
                if (!ready || receipt.revision > ready.revision) ready = receipt
                update()
            }))
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
            for (const frame of frames) cancelAnimationFrame(frame)
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
