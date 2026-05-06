import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SkillSummary } from '@/types/api'
import { searchSkills, skillToSearchResult, type SkillSearchResult } from '@/lib/skill-search'
import { getRecentSkills, recentEntryToSkill, type RecentSkillEntry } from '@/lib/recent-skills'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'

type SkillPickerDialogProps = {
    open: boolean
    initialQuery: string
    skills: readonly SkillSummary[]
    refreshSkills?: () => Promise<SkillSummary[]>
    onSelect: (suggestion: SkillSearchResult) => void
    onClose: () => void
}

type SkillPickerTab = 'recent' | 'all'

function initialTab(query: string): SkillPickerTab {
    return query.trim() ? 'all' : 'recent'
}

function scopeLabel(suggestion: SkillSearchResult): string {
    return suggestion.scope.toUpperCase()
}

function compactPath(path: string | undefined): string {
    if (!path) return ''
    const parts = path.split('/').filter(Boolean)
    if (parts.length <= 4) {
        return path
    }
    return `.../${parts.slice(-4).join('/')}`
}

export function SkillPickerDialog(props: SkillPickerDialogProps) {
    const { open, initialQuery, skills, refreshSkills, onSelect, onClose } = props
    const [query, setQuery] = useState(initialQuery)
    const [loadedSkills, setLoadedSkills] = useState<readonly SkillSummary[]>(skills)
    const [recentSkills, setRecentSkills] = useState<readonly RecentSkillEntry[]>([])
    const [activeTab, setActiveTab] = useState<SkillPickerTab>(() => initialTab(initialQuery))
    const [selectedIndex, setSelectedIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        setQuery(initialQuery)
        setLoadedSkills(skills)
        setRecentSkills(getRecentSkills())
        setActiveTab(initialTab(initialQuery))
        setSelectedIndex(0)
    }, [open, initialQuery, skills])

    useEffect(() => {
        if (!open || !refreshSkills) return

        let cancelled = false
        void refreshSkills().then((nextSkills) => {
            if (cancelled) return
            setLoadedSkills(nextSkills)
        }).catch(() => {
            if (cancelled) return
            setLoadedSkills([])
            setSelectedIndex(-1)
        })

        return () => {
            cancelled = true
        }
    }, [open, refreshSkills])

    const allSuggestions = useMemo(
        () => searchSkills(loadedSkills, `$${query}`),
        [loadedSkills, query]
    )
    const currentSkillResultsByKey = useMemo(() => {
        const entries = loadedSkills.map((skill) => {
            const result = skillToSearchResult(skill)
            return [result.key, result] as const
        })
        return new Map(entries)
    }, [loadedSkills])
    const recentSuggestions = useMemo(
        () => recentSkills.map((entry) => (
            currentSkillResultsByKey.get(entry.key) ?? skillToSearchResult(recentEntryToSkill(entry))
        )),
        [currentSkillResultsByKey, recentSkills]
    )
    const queryHasText = query.trim().length > 0
    const suggestions = activeTab === 'recent' && !queryHasText
        ? recentSuggestions
        : allSuggestions

    useEffect(() => {
        if (queryHasText) {
            setActiveTab('all')
        }
    }, [queryHasText])

    useEffect(() => {
        setSelectedIndex((current) => {
            if (suggestions.length === 0) {
                return -1
            }
            if (current < 0) {
                return 0
            }
            return Math.min(current, suggestions.length - 1)
        })
    }, [suggestions.length])

    useEffect(() => {
        if (!open) return
        requestAnimationFrame(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
        })
    }, [open])

    useEffect(() => {
        if (selectedIndex < 0 || selectedIndex >= suggestions.length) return
        const selectedEl = listRef.current?.querySelector<HTMLButtonElement>(
            `[data-skill-index="${selectedIndex}"]`
        )
        selectedEl?.scrollIntoView({ block: 'nearest' })
    }, [selectedIndex, suggestions.length])

    const selectedSuggestion = selectedIndex >= 0 ? suggestions[selectedIndex] : undefined

    const selectSuggestion = useCallback((suggestion: SkillSearchResult | undefined) => {
        if (!suggestion) return
        onSelect(suggestion)
    }, [onSelect])

    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        if (event.nativeEvent.isComposing) {
            return
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSelectedIndex((current) => {
                if (suggestions.length === 0) return -1
                return current >= suggestions.length - 1 ? 0 : current + 1
            })
            return
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSelectedIndex((current) => {
                if (suggestions.length === 0) return -1
                return current <= 0 ? suggestions.length - 1 : current - 1
            })
            return
        }

        if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
            if (!selectedSuggestion) return
            event.preventDefault()
            selectSuggestion(selectedSuggestion)
            return
        }

        if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
        }
    }, [onClose, selectSuggestion, selectedSuggestion, suggestions.length])

    const resultCountLabel = useMemo(() => {
        if (suggestions.length === 1) {
            return '1 skill'
        }
        return `${suggestions.length} skills`
    }, [suggestions.length])

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => {
            if (!nextOpen) onClose()
        }}>
            <DialogContent
                aria-describedby={undefined}
                className="flex h-[calc(100vh-24px)] max-h-[720px] w-[calc(100vw-24px)] max-w-3xl flex-col overflow-hidden p-0 sm:h-[min(720px,calc(100vh-48px))]"
                onKeyDown={handleKeyDown}
            >
                <DialogHeader className="border-b border-[var(--app-divider)] px-4 py-3 text-left">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <DialogTitle>Skills</DialogTitle>
                            <div className="mt-1 text-xs text-[var(--app-hint)]">{resultCountLabel}</div>
                        </div>
                        <button
                            type="button"
                            aria-label="Close"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            onClick={onClose}
                        >
                            x
                        </button>
                    </div>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search skills"
                        className="mt-3 h-10 w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                    />
                    <div className="mt-3 grid grid-cols-2 border-b border-[var(--app-divider)]" role="tablist" aria-label="Skill views">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'recent' && !queryHasText}
                            className={`relative py-2 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-secondary-bg)] ${
                                activeTab === 'recent' && !queryHasText ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'
                            }`}
                            onClick={() => {
                                setQuery('')
                                setActiveTab('recent')
                            }}
                        >
                            Recent
                            <span
                                className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${
                                    activeTab === 'recent' && !queryHasText ? 'bg-[var(--app-link)]' : 'bg-transparent'
                                }`}
                            />
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'all' || queryHasText}
                            className={`relative py-2 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-secondary-bg)] ${
                                activeTab === 'all' || queryHasText ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'
                            }`}
                            onClick={() => setActiveTab('all')}
                        >
                            All
                            <span
                                className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${
                                    activeTab === 'all' || queryHasText ? 'bg-[var(--app-link)]' : 'bg-transparent'
                                }`}
                            />
                        </button>
                    </div>
                </DialogHeader>

                <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2">
                    {suggestions.length === 0 ? (
                        <div className="px-4 py-10 text-center text-sm text-[var(--app-hint)]">
                            {activeTab === 'recent' && !queryHasText ? 'No recent skills' : 'No matching skills'}
                        </div>
                    ) : suggestions.map((suggestion, index) => {
                        const selected = index === selectedIndex
                        const path = compactPath(suggestion.path)
                        const description = suggestion.skill.description
                        return (
                            <button
                                key={suggestion.key}
                                type="button"
                                data-skill-index={index}
                                className={`flex w-full cursor-pointer flex-col items-start gap-1 px-4 py-3 text-left transition-colors ${
                                    selected
                                        ? 'bg-[var(--app-button)] text-[var(--app-button-text)]'
                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => selectSuggestion(suggestion)}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setSelectedIndex(index)}
                            >
                                <span className="flex w-full min-w-0 items-center gap-2">
                                    <span className="truncate text-sm font-semibold">{suggestion.label}</span>
                                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none ${
                                        selected
                                            ? 'border-current opacity-80'
                                            : 'border-[var(--app-divider)] text-[var(--app-hint)]'
                                    }`}>
                                        {scopeLabel(suggestion)}
                                    </span>
                                </span>
                                {description ? (
                                    <span className={`line-clamp-2 w-full text-xs leading-snug ${
                                        selected ? 'opacity-80' : 'text-[var(--app-hint)]'
                                    }`}>
                                        {description}
                                    </span>
                                ) : null}
                                {path ? (
                                    <span className={`w-full truncate font-mono text-[11px] ${
                                        selected ? 'opacity-70' : 'text-[var(--app-hint)]'
                                    }`}>
                                        {path}
                                    </span>
                                ) : null}
                            </button>
                        )
                    })}
                </div>
            </DialogContent>
        </Dialog>
    )
}
