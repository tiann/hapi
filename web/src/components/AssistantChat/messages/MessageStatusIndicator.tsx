import type { MessageStatus } from '@/types/api'

function ErrorIcon() {
    return (
        <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

export function MessageStatusIndicator(props: {
    status?: MessageStatus
    onRetry?: () => void
}) {
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
