import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'

/**
 * Hub opt-in to show compact AGENT_NOTIFY_SUMMARY in chat.
 * Default false (hide/strip). Value is polled once in the chat shell and
 * exposed via HappyChatContext — message renderers must not install their
 * own refetch intervals.
 */
export function useSessionSummaryInChat(): boolean {
    const ctx = useOptionalHappyChatContext()
    return ctx?.showSessionSummaryInChat === true
}
