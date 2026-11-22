import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportActions } from './LocalSessionImportActions'

/** Antigravity-flavored wrapper around the generic import actions strip. */
export function AgyImportActions(props: {
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
                inlineTitle: t('agyImport.inline.title'),
                inlineDescription: t('agyImport.inline.description'),
                inlineClear: t('agyImport.inline.clear'),
                inlineChoose: t('agyImport.inline.choose'),
                loading: t('agyImport.loading')
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
