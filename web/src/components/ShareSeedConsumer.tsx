import { useEffect, useRef } from 'react'
import { useAssistantApi, useAssistantState } from '@assistant-ui/react'
import { consumeSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, getShareTransfer } from '@/lib/shareTransfer'
import { getDraft } from '@/lib/composer-drafts'

/**
 * Consumes a pending Web Share Target transfer once the assistant runtime
 * is mounted and the session is active enough to accept attachments.
 *
 * Lifecycle:
 *  - The sessionStorage pending key is left untouched while
 *    `sessionActive` is false. Inactive mounts (e.g. sharing into a
 *    stopped session that then reopens under a new HAPI session id) must
 *    not steal the hand-off — otherwise the remounted chat never sees
 *    the transfer. Consume + seed happen in the same effect once active.
 *  - Consume runs in an effect, not during render — React.StrictMode
 *    double-invokes render functions in dev; a render-time consume
 *    would delete the key on the discarded pass.
 *  - `consumedRef` gates a single seed per component instance — refs
 *    survive a StrictMode mount/cleanup/remount pair, so the second
 *    effect invoke early-returns and the first invoke's async chain
 *    completes naturally (we deliberately don't cancel on cleanup; the
 *    upload is idempotent and composer side effects no-op once the
 *    runtime is unmounted).
 *  - The IDB row is deleted after the seed completes so a back-button
 *    refresh of /sessions/:id doesn't re-attach the same payload.
 */
export function ShareSeedConsumer(props: { sessionId: string; sessionActive: boolean }) {
    const assistantApi = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const composerTextRef = useRef(composerText)
    const consumedRef = useRef(false)

    useEffect(() => {
        composerTextRef.current = composerText
    }, [composerText])

    useEffect(() => {
        if (!props.sessionActive) return
        if (consumedRef.current) return
        const transferId = consumeSharePendingTransfer()
        if (!transferId) return
        consumedRef.current = true

        void (async () => {
            try {
                const payload = await getShareTransfer(transferId)
                if (!payload) return
                const seedText = [payload.title, payload.text, payload.url]
                    .filter((part) => typeof part === 'string' && part.length > 0)
                    .join('\n')
                    .trim()
                if (seedText.length > 0) {
                    const existingText = composerTextRef.current.trim().length > 0
                        ? composerTextRef.current
                        : getDraft(props.sessionId)
                    const nextText = [existingText.trim(), seedText]
                        .filter((part) => part.length > 0)
                        .join('\n\n')
                    if (nextText.length > 0) {
                        assistantApi.composer().setText(nextText)
                    }
                }
                for (const file of payload.files) {
                    const reconstructed = new File([file.blob], file.name, { type: file.type })
                    try {
                        await assistantApi.composer().addAttachment(reconstructed)
                    } catch (err) {
                        console.error('share-seed addAttachment failed', err)
                    }
                }
                await deleteShareTransfer(transferId).catch(() => {})
            } catch (err) {
                console.error('share-seed pull failed', err)
            }
        })()
    }, [props.sessionActive, props.sessionId, assistantApi])

    return null
}
