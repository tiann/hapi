import type { Session } from '@/types/api'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

function getSourceSessionId(session: Session): string | null {
    const flavor = session.metadata?.flavor
    if (flavor === 'codex') {
        return session.metadata?.codexSessionId ?? null
    }
    if (flavor === 'claude') {
        return session.metadata?.claudeSessionId ?? null
    }
    return null
}

async function copyText(value: string) {
    if (!navigator?.clipboard?.writeText) {
        return
    }
    await navigator.clipboard.writeText(value)
}

function SessionInfoRow(props: {
    label: string
    value: string
    canCopy?: boolean
}) {
    const { t } = useTranslation()

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">
                {props.label}
            </div>
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 break-all text-sm text-[var(--app-fg)]">
                    {props.value}
                </div>
                {props.canCopy ? (
                    <Button
                        type="button"
                        variant="secondary"
                        className="h-8 px-2 text-xs"
                        onClick={() => void copyText(props.value)}
                    >
                        {t('button.copy')}
                    </Button>
                ) : null}
            </div>
        </div>
    )
}

export function SessionInfoDialog(props: {
    session: Session
    open: boolean
    onClose: () => void
}) {
    const { t } = useTranslation()
    const sourceSessionId = getSourceSessionId(props.session)
    const agent = props.session.metadata?.flavor?.trim() || t('session.info.notAvailable')
    const workingDirectory = props.session.metadata?.path || t('session.info.notAvailable')

    return (
        <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('session.info.title')}</DialogTitle>
                    <DialogDescription>
                        {t('session.info.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-2 flex flex-col gap-3">
                    <SessionInfoRow
                        label={t('session.info.agent')}
                        value={agent}
                    />
                    <SessionInfoRow
                        label={t('session.info.workingDirectory')}
                        value={workingDirectory}
                        canCopy
                    />
                    <SessionInfoRow
                        label={t('session.info.hapiSessionId')}
                        value={props.session.id}
                        canCopy
                    />
                    <SessionInfoRow
                        label={t('session.info.sourceSessionId')}
                        value={sourceSessionId ?? t('session.info.notAvailable')}
                        canCopy={Boolean(sourceSessionId)}
                    />
                </div>
            </DialogContent>
        </Dialog>
    )
}
