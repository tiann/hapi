import { useEffect, useRef, type RefObject } from 'react'
import { followSessionTail, markSessionSeen } from '@/lib/sessionLastSeen'
import { useDocumentVisibility } from './useDocumentVisibility'

/** Called by the rendered transcript, never by list selection or SSE metadata. */
export function useSelectedSessionSeen(
    sessionId: string | null,
    renderedRevision: number | undefined,
    stateVersion: number | undefined,
    viewportRef: RefObject<HTMLElement | null>,
    contentRef: RefObject<HTMLElement | null>
): void {
    const visible = useDocumentVisibility()
    const version = useRef(stateVersion)
    version.current = stateVersion
    const followsTail = visible && renderedRevision !== undefined
    // Suppress transient unread dots only while the user is actually at the tail.
    useEffect(() => {
        if (!followsTail || !sessionId) return
        const viewport = viewportRef.current
        if (!viewport) return
        let stopFollowing: (() => void) | undefined
        const update = () => {
            const atTail = viewport.clientHeight > 0
                && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2
            if (atTail && !stopFollowing) stopFollowing = followSessionTail(sessionId)
            else if (!atTail && stopFollowing) { stopFollowing(); stopFollowing = undefined }
        }
        viewport.addEventListener('scroll', update, { passive: true })
        update()
        return () => { viewport.removeEventListener('scroll', update); stopFollowing?.() }
    }, [followsTail, sessionId, viewportRef])
    useEffect(() => {
        if (!visible || !sessionId || renderedRevision === undefined) return
        const viewport = viewportRef.current
        const content = contentRef.current
        if (!viewport || !content) return
        let frame = 0
        let acknowledged = false
        const check = () => {
            cancelAnimationFrame(frame)
            // The chat runtime publishes rows in an effect. Wait for its DOM
            // and the subsequent layout/scroll correction before acknowledging.
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => {
                    if (acknowledged || viewport.clientHeight <= 0) return
                    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 2) return
                    acknowledged = true
                    markSessionSeen(sessionId, renderedRevision, version.current)
                })
            })
        }
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
        const mutations = new MutationObserver(check)
        resize?.observe(content)
        mutations.observe(content, { subtree: true, childList: true, characterData: true })
        viewport.addEventListener('scroll', check, { passive: true })
        check()
        return () => {
            cancelAnimationFrame(frame)
            resize?.disconnect()
            mutations.disconnect()
            viewport.removeEventListener('scroll', check)
        }
        // A read-state SSE update alone is not a new viewing action.
    }, [visible, sessionId, renderedRevision, viewportRef, contentRef])
}
