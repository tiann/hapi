import { useMemo } from 'react'
import type { Session } from '@/types/api'
import { isTelegramApp } from '@/hooks/useTelegram'

function getSessionTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
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

    // In Telegram, don't render header (Telegram provides its own)
    if (isTelegramApp()) {
        return null
    }

    return (
        <div className="bg-[var(--app-bg)]">
            <div className="mx-auto w-full max-w-[720px] flex items-center gap-2 p-3">
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

                {/* Session info - two lines: title and path */}
                <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">
                        {title}
                    </div>
                    <div className="text-xs text-[var(--app-hint)] truncate">
                        {props.session.metadata?.path ?? props.session.id}
                    </div>
                </div>
            </div>
        </div>
    )
}
