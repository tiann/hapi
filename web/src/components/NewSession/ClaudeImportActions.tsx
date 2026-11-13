import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportActions } from './LocalSessionImportActions'

/** Claude-flavored wrapper around the generic import actions strip. */
export function ClaudeImportActions(props: {
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
                inlineTitle: t('claudeImport.inline.title'),
                inlineDescription: t('claudeImport.inline.description'),
                inlineClear: t('claudeImport.inline.clear'),
                inlineChoose: t('claudeImport.inline.choose'),
                loading: t('claudeImport.loading')
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