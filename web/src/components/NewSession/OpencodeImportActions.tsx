import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportActions } from './LocalSessionImportActions'

/** OpenCode-flavored wrapper around the generic import actions strip. */
export function OpencodeImportActions(props: {
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
                inlineTitle: t('opencodeSync.inline.title'),
                inlineDescription: t('opencodeSync.inline.description'),
                inlineClear: t('opencodeSync.inline.clear'),
                inlineChoose: t('opencodeSync.inline.choose'),
                loading: t('opencodeSync.loading')
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