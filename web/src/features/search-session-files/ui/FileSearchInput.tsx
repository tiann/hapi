import { useState, useCallback } from 'react'
import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

type FileSearchInputProps = {
    sessionId: string
    onResultSelect?: (path: string) => void
    placeholder?: string
}

export function FileSearchInput(props: FileSearchInputProps) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { sessionId, onResultSelect, placeholder } = props
    const [query, setQuery] = useState('')
    const { files, isLoading } = useSessionFileSearch(api, sessionId, query)

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setQuery(e.target.value)
    }, [])

    const handleResultClick = useCallback((path: string) => {
        onResultSelect?.(path)
        setQuery('')
    }, [onResultSelect])

    return (
        <div className="relative">
            <input
                type="text"
                value={query}
                onChange={handleInputChange}
                placeholder={placeholder ?? t('search.placeholder')}
                className="w-full px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent"
            />
            {query && files.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg max-h-60 overflow-y-auto z-50">
                    {files.map((file) => (
                        <button
                            key={file.fullPath}
                            type="button"
                            onClick={() => handleResultClick(file.fullPath)}
                            className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] focus:outline-none focus:bg-[var(--app-subtle-bg)]"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-[var(--app-hint)]">{file.fullPath}</span>
                            </div>
                        </button>
                    ))}
                </div>
            )}
            {isLoading && query && (
                <div className="absolute top-full left-0 right-0 mt-1 px-3 py-2 text-sm text-[var(--app-hint)]">
                    {t('search.loading')}
                </div>
            )}
        </div>
    )
}
