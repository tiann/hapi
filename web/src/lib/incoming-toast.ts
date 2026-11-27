import type { I18nContextValue } from './i18n-context'
import { translateInputRequestTitle } from './input-request-toast'

/**
 * Puts a toast the hub sent into the user's language. The hub writes its
 * toasts in English and tells them apart by their title; where the body
 * carries names that belong in the translated sentence (an agent, a session,
 * a message), they are read out of the hub's English sentence. Anything else
 * is shown as it came.
 */
export function translateIncomingToast(
    title: string,
    body: string,
    t: I18nContextValue['t']
): { title: string; body: string } {
    const normalizedTitle = title.trim()
    const normalizedBody = body.trim()
    const inputTitle = translateInputRequestTitle(normalizedTitle, t)
    if (inputTitle) {
        return { title: inputTitle, body: normalizedBody }
    }

    if (normalizedTitle === 'Ready for input') {
        const waitingMatch = normalizedBody.match(/^(.+)\s+is waiting in\s+(.+)$/i)
        if (waitingMatch) {
            const agent = waitingMatch[1]?.trim() ?? ''
            const sessionName = waitingMatch[2]?.trim() ?? ''
            return {
                title: t('toast.ready.title'),
                body: t('toast.ready.body', { agent, session: sessionName })
            }
        }
        return {
            title: t('toast.ready.title'),
            body: normalizedBody
        }
    }

    // A scheduled message that came due on a session the hub could not resume. The hub names the
    // message (its first words in quotes, or "A scheduled message" when it has none) and the session,
    // whose name may contain a colon of its own.
    if (normalizedTitle === 'Scheduled message not sent') {
        const waitingMatch = normalizedBody.match(
            /^(.+)\s+is waiting in\s+(.+):\s+the session could not be resumed\.\s+The hub keeps retrying\.$/i
        )
        if (waitingMatch) {
            const message = waitingMatch[1]?.trim() ?? ''
            return {
                title: t('toast.scheduledNotSent.title'),
                body: t('toast.scheduledNotSent.body', {
                    message: message === 'A scheduled message' ? t('toast.scheduledNotSent.unnamed') : message,
                    session: waitingMatch[2]?.trim() ?? ''
                })
            }
        }
        return {
            title: t('toast.scheduledNotSent.title'),
            body: normalizedBody
        }
    }

    if (normalizedTitle === 'Permission Request') {
        return {
            title: t('toast.permission.title'),
            body: normalizedBody
        }
    }

    if (normalizedTitle === 'Task completed') {
        return {
            title: t('toast.task.completed'),
            body: normalizedBody
        }
    }

    if (normalizedTitle === 'Task failed') {
        return {
            title: t('toast.task.failed'),
            body: normalizedBody
        }
    }

    return { title, body }
}
