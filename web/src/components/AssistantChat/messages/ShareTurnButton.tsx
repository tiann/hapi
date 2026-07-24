import { useAssistantState } from '@assistant-ui/react'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { useTranslation } from '@/lib/use-translation'

function ShareIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 10.7 15.4 6.3" />
            <path d="M8.6 13.3 15.4 17.7" />
        </svg>
    )
}

export function ShareTurnButton(props: {
    messageElementId: string
    className?: string
    fallbackText?: string
}) {
    const ctx = useOptionalHappyChatContext()
    const { t } = useTranslation()
    const fallbackUserText = useAssistantState(({ message, thread }) => {
        const currentIndex = thread.messages.findIndex((candidate) => candidate.id === message.id)
        if (currentIndex < 0) return ''
        for (let index = currentIndex; index >= 0; index -= 1) {
            const candidate = thread.messages[index]
            if (candidate?.role !== 'user') continue
            return candidate.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
                .trim()
        }
        return ''
    })
    const onShareTurn = ctx?.onShareTurn
    if (!onShareTurn) return null
    const fallbackText = props.fallbackText?.trim() ?? ''

    return (
        <button
            type="button"
            data-hapi-share-action="true"
            title={t('message.shareTurn')}
            aria-label={t('message.shareTurn')}
            className={props.className ?? 'rounded-md p-0.5 opacity-60 transition-[opacity,background-color] hover:bg-[var(--app-subtle-bg)] sm:opacity-0 sm:group-hover/msg:opacity-100'}
            onClick={(event) => {
                event.stopPropagation()
                const messageElement = event.currentTarget.closest('[data-hapi-message-role]')
                onShareTurn(
                    messageElement instanceof HTMLElement ? messageElement : props.messageElementId,
                    event.clientY,
                    fallbackUserText.length > 0
                        ? { html: '', text: fallbackUserText, role: 'user' }
                        : fallbackText.length > 0
                            ? { html: '', text: fallbackText, role: 'assistant' }
                        : undefined
                )
            }}
        >
            <ShareIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />
        </button>
    )
}
