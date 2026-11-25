import { useState } from 'react'
import { AttachedJobSchema, type AttachedJob } from '@hapi/protocol'
import { ApiError, apiErrorMessage, type ApiClient } from '@/api/client'
import { useIsMutating } from '@tanstack/react-query'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { sessionArchiveMutationKey } from '@/hooks/mutations/useSessionActions'
import { useTranslation } from '@/lib/use-translation'

type DeleteSessionDialogProps = {
    isOpen: boolean
    api?: ApiClient | null
    sessionId: string
    onClose: () => void
    description: string
    onConfirm: () => Promise<void>
    isPending: boolean
}

export function DeleteSessionDialog(props: DeleteSessionDialogProps) {
    // Closed dialogs (including the header's always-mounted wrapper) must not
    // subscribe to every mutation-cache notification across the session list.
    return props.isOpen ? <OpenDeleteSessionDialog key={props.sessionId} {...props} /> : null
}

function OpenDeleteSessionDialog(props: DeleteSessionDialogProps) {
    const { t } = useTranslation()
    // A row may remount, or the archive may originate in another view. Observe
    // shared progress only while this dialog needs to gate deletion.
    const isArchiving = useIsMutating({ mutationKey: sessionArchiveMutationKey(props.sessionId), exact: true }) > 0
    const [blockedJob, setBlockedJob] = useState<AttachedJob | null>(null)
    const [jobChanged, setJobChanged] = useState(false)
    const [clearing, setClearing] = useState(false)
    const api = props.api
    if (blockedJob && api) {
        return <ConfirmDialog key="clear" isOpen onClose={props.onClose} title={t('dialog.delete.clearMeter')}
            description={t('dialog.delete.clearMeterDetail', { job: blockedJob.label })}
            confirmLabel={t('dialog.delete.clearMeter')} confirmingLabel={t('dialog.delete.clearMeter')}
            isPending={clearing || isArchiving || props.isPending} destructive keepOpenAfterConfirm
            onConfirm={async () => {
                setClearing(true)
                try {
                    await api.clearStaleSessionJob(props.sessionId, blockedJob)
                } catch (error) {
                    if (!(error instanceof ApiError) || error.code !== 'job_changed') throw error
                    setJobChanged(true)
                } finally { setClearing(false) }
                setBlockedJob(null)
            }} />
    }
    const confirmDelete = async () => {
        setJobChanged(false)
        try {
            await props.onConfirm()
            props.onClose()
        } catch (error) {
            if (error instanceof ApiError && error.status === 409 && error.code === 'attached_job_running') {
                const conflict = JSON.parse(error.body ?? '{}')
                const job = AttachedJobSchema.safeParse(conflict.job)
                if (job.success) {
                    if (conflict.canClearStale === true && props.api) { setBlockedJob(job.data); return }
                    throw new Error(t('dialog.delete.liveMeter', { job: job.data.label }))
                }
            }
            throw new Error(apiErrorMessage(error, t('dialog.error.default')))
        }
    }
    return (
        <ConfirmDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            title={t('dialog.delete.title')}
            description={isArchiving ? t('dialog.delete.waitingForArchiveDescription')
                : jobChanged ? t('dialog.delete.jobChanged') : props.description}
            confirmLabel={t(isArchiving ? 'dialog.delete.waitingForArchive' : 'dialog.delete.confirm')}
            confirmingLabel={t('dialog.delete.confirming')}
            onConfirm={confirmDelete}
            keepOpenAfterConfirm
            isPending={props.isPending && !isArchiving}
            isConfirmDisabled={isArchiving}
            destructive
            centerTitle
        />
    )
}
