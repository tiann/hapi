import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

export function useForkWithFeedback(
    forkSession: () => Promise<{ sessionId: string; warnings?: string[] }>,
    sessionName: string
) {
    const { addToast } = useToast()
    const { t } = useTranslation()

    // Returns void: callers stay on the source session and rely on the toast's
    // sessionId/actionLabel to surface a click-through to the new session.
    return async () => {
        try {
            const { sessionId: newSessionId, warnings } = await forkSession()
            addToast({
                title: t('dialog.fork.successTitle'),
                body: t('dialog.fork.successDescription', { name: sessionName }),
                sessionId: newSessionId,
                url: `/sessions/${newSessionId}`,
                variant: 'success',
                actionLabel: t('toast.action.openSession')
            })
            if (warnings && warnings.length > 0) {
                addToast({
                    title: t('dialog.fork.partialTitle'),
                    body: warnings.join('; '),
                    variant: 'error'
                })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : t('dialog.fork.failedDescription')
            // No sessionId/url: clicking the toast on the page you're already on would just dismiss
            // it, which is what the close affordance already does.
            addToast({
                title: t('dialog.fork.failedTitle'),
                body: message,
                variant: 'error'
            })
        }
    }
}
