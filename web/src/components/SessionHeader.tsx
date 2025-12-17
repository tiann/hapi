import { useMemo } from 'react'
import type { Session } from '@/types/api'

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

export function SessionHeader(props: {
    session: Session
    onBack: () => void
}) {
    const title = useMemo(() => getSessionTitle(props.session), [props.session])

    return (
        <div className="flex items-center gap-2 bg-[var(--app-bg)] p-3">
            {/* Back button */}
            <button
                type="button"
                onClick={props.onBack}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <polyline points="15 18 9 12 15 6" />
                </svg>
            </button>

            {/* Session info */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className={props.session.active ? 'h-2.5 w-2.5 rounded-full bg-emerald-500' : 'h-2.5 w-2.5 rounded-full bg-gray-400'}
                        title={props.session.active ? 'active' : 'offline'}
                        aria-label={props.session.active ? 'active' : 'offline'}
                    />
                    <div className="truncate font-semibold">
                        {title}
                    </div>
                    {props.session.thinking ? (
                        <span
                            className="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse"
                            title="thinking"
                            aria-label="thinking"
                        />
                    ) : null}
                </div>
                <div className="text-xs text-[var(--app-hint)] truncate">
                    {props.session.metadata?.host ? `Host: ${props.session.metadata.host}` : props.session.id}
                </div>
            </div>
        </div>
    )
}
