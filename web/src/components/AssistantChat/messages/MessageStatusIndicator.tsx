import type { MessageStatus } from '@/types/api'

function ErrorIcon() {
    return (
        <svg className="block h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function QueuedIcon() {
    return (
        <svg className="block h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function SendingIcon() {
    return (
        <svg className="block h-[14px] w-[14px] animate-spin" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
            <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

export function MessageStatusIndicator(props: {
    status?: MessageStatus
    onRetry?: () => void
}) {
    if (props.status === 'queued') {
        return (
            <span role="status" aria-label="Queued" className="inline-flex h-4 w-4 items-center justify-center text-[var(--app-fg-muted)]">
                <QueuedIcon />
            </span>
        )
    }

    if (props.status === 'sending') {
        return (
            <span role="status" aria-label="Sending" className="inline-flex h-4 w-4 items-center justify-center text-[var(--app-fg-muted)]">
                <SendingIcon />
            </span>
        )
    }

    if (props.status !== 'failed') {
        return null
    }

    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-red-500">
                <ErrorIcon />
            </span>
            {props.onRetry ? (
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="text-xs text-blue-500 hover:underline"
                >
                    Retry
                </button>
            ) : null}
        </span>
    )
}
