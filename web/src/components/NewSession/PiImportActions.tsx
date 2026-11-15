import type { LocalSessionListItem } from '@/lib/localSessionImport'
import { useTranslation } from '@/lib/use-translation'
import { LocalSessionImportActions } from './LocalSessionImportActions'

/** Pi-flavored wrapper around the generic import actions strip. */
export function PiImportActions(props: {
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
                inlineTitle: t('piImport.inline.title'),
                inlineDescription: t('piImport.inline.description'),
                inlineClear: t('piImport.inline.clear'),
                inlineChoose: t('piImport.inline.choose'),
                loading: t('piImport.loading')
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