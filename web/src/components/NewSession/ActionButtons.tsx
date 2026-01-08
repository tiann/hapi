import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

export function ActionButtons(props: {
    isPending: boolean
    canCreate: boolean
    isDisabled: boolean
    onCancel: () => void
    onCreate: () => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex gap-2 px-3 py-3">
            <Button
                variant="secondary"
                onClick={props.onCancel}
                disabled={props.isDisabled}
            >
                {t('button.cancel')}
            </Button>
            <Button
                onClick={props.onCreate}
                disabled={!props.canCreate}
                aria-busy={props.isPending}
                className="gap-2"
            >
                {props.isPending ? (
                    <>
                        <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                        {t('newSession.creating')}
                    </>
                ) : (
                    t('newSession.create')
                )}
            </Button>
        </div>
    )
}
