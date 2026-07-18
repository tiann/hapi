import { useAssistantState } from '@assistant-ui/react'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

type FormattedMessageTimestamp = {
    label: string
    title: string
    dateTime: string
}

function pad2(value: number): string {
    return String(value).padStart(2, '0')
}

function toDate(value: unknown): Date | null {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value
    }
    if (typeof value === 'number' || typeof value === 'string') {
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? null : date
    }
    return null
}

function isSameLocalDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate()
}

export function formatMessageTimestamp(value: unknown, now: Date = new Date()): FormattedMessageTimestamp | null {
    const date = toDate(value)
    if (!date) return null

    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    const label = isSameLocalDay(date, now)
        ? time
        : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`
    const title = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}:${pad2(date.getSeconds())}`

    return {
        label,
        title,
        dateTime: date.toISOString()
    }
}

export function HappyMessageTimestamp(props: {
    align?: 'left' | 'right'
    className?: string
}) {
    const timestampValue = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (message.role === 'assistant' && custom?.timestampSource === 'completion') {
            return custom.timestampAt ?? null
        }
        return (message as { createdAt?: unknown }).createdAt
    })
    const timestamp = formatMessageTimestamp(timestampValue)
    if (!timestamp) return null

    const alignClass = props.align === 'right' ? 'justify-end' : 'justify-start'
    const className = ['flex', alignClass, props.className].filter(Boolean).join(' ')

    return (
        <div className={className}>
            <time
                dateTime={timestamp.dateTime}
                title={timestamp.title}
                className="select-none text-[10px] leading-none text-[var(--app-hint)] opacity-70"
            >
                {timestamp.label}
            </time>
        </div>
    )
}
