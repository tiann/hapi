import { Component, createRef, type ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'

type Props = { children: ReactNode; className: string; sessions: SessionSummary[] }
type Snapshot = { scrollTop: number; anchors: { element: HTMLElement; top: number }[] }

/** Read the old DOM at commit time, before rows move between pinned sections. */
export class SessionListScrollAnchor extends Component<Props, object, Snapshot | null> {
    private contentRef = createRef<HTMLDivElement>()

    getSnapshotBeforeUpdate(previousProps: Props): Snapshot | null {
        if (previousProps.sessions === this.props.sessions) return null
        const content = this.contentRef.current
        const container = content?.parentElement
        if (!content || !container || container.scrollTop <= 0) return null
        const viewport = container.getBoundingClientRect()
        const anchors: Snapshot['anchors'] = []
        for (const element of content.querySelectorAll<HTMLElement>('[data-session-scroll-anchor]')) {
            if (element.closest('.collapsible-panel:not([data-open])')) continue
            const rect = element.getBoundingClientRect()
            if (rect.top >= viewport.bottom) break
            // A project's box can span the whole viewport; only anchor its visible header.
            const isRow = element.classList.contains('session-list-item')
            if (rect.height > 0 && rect.bottom > viewport.top && (isRow || rect.top >= viewport.top)) {
                anchors.push({ element, top: rect.top - viewport.top })
            }
        }
        return { scrollTop: container.scrollTop, anchors }
    }

    componentDidUpdate(_previousProps: Props, _previousState: object, snapshot: Snapshot | null) {
        const content = this.contentRef.current
        const container = content?.parentElement
        if (!content || !container || !snapshot) return
        const viewportTop = container.getBoundingClientRect().top
        // Prefer the least-reordered survivor, not a project that was just sent to
        // the top/bottom. Compare content offsets so native scroll anchoring cannot
        // make that moved project look stationary.
        const candidates = snapshot.anchors
            .filter(({ element }) => content.contains(element)
                && !element.closest('.collapsible-panel:not([data-open])'))
            .map(anchor => ({ ...anchor, rect: anchor.element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.height > 0)
            .map(anchor => ({
                ...anchor,
                shift: anchor.rect.top - viewportTop + container.scrollTop - anchor.top - snapshot.scrollTop,
            }))
            .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift))
        const anchor = candidates[0]
        const scrollTop = anchor ? snapshot.scrollTop + anchor.shift : snapshot.scrollTop
        if (Math.abs(container.scrollTop - scrollTop) > 0.5) container.scrollTop = scrollTop
    }

    render() {
        return <div ref={this.contentRef} className={this.props.className}>{this.props.children}</div>
    }
}
