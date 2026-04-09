import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

export function useForkWithFeedback(
    forkSession: () => Promise<string>,
    sessionId: string,
    sessionName: string
) {
    const { addToast } = useToast()
    const { t } = useTranslation()

    return async (onSuccess: (newSessionId: string) => void) => {
        try {
            const newSessionId = await forkSession()
            addToast({
                title: t('dialog.fork.successTitle'),
                body: t('dialog.fork.successDescription', { name: sessionName }),
                sessionId: newSessionId,
                url: `/sessions/${newSessionId}`,
                variant: 'success',
                actionLabel: t('toast.action.openSession')
            })
            onSuccess(newSessionId)
        } catch (error) {
            const message = error instanceof Error ? error.message : t('dialog.fork.failedDescription')
            addToast({
                title: t('dialog.fork.failedTitle'),
                body: message,
                sessionId,
                url: `/sessions/${sessionId}`
            })
        }
    }
}
