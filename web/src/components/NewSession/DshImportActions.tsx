import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportActions } from './LocalSessionImportActions'

/** DSH-flavored wrapper around the generic import actions strip. */
export function DshImportActions(props: {
    selectedSession: LocalSessionListItem | null
    isLoading: boolean
    isDisabled: boolean
    error: string | null
    onChooseHistory: () => void
    onClear: () => void
}) {
    const { t } = useTranslation()
    return (
        <LocalSessionImportActions
            labels={{
                inlineTitle: t('dshSync.inline.title'),
                inlineDescription: t('dshSync.inline.description'),
                inlineClear: t('dshSync.inline.clear'),
                inlineChoose: t('dshSync.inline.choose'),
                loading: t('dshSync.loading')
            }}
            selectedSession={props.selectedSession}
            isLoading={props.isLoading}
            isDisabled={props.isDisabled}
            error={props.error}
            onChooseHistory={props.onChooseHistory}
            onClear={props.onClear}
        />
    )
}
