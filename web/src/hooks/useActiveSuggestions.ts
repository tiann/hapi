import { useState, useCallback, useEffect, useRef } from 'react'

export interface Suggestion {
    key: string
    text: string
    label: string
    description?: string
}

interface SuggestionOptions {
    clampSelection?: boolean   // If true, clamp instead of preserving exact position
    autoSelectFirst?: boolean  // If true, automatically select first item when suggestions appear
    wrapAround?: boolean       // If true, wrap around when reaching top/bottom
    allowEmptyQuery?: boolean  // If true, allow empty string queries
}

/**
 * A simple value sync class that processes the latest value
 * Ensures only the most recent query is processed
 */
class ValueSync<T> {
    private latestValue: T | undefined
    private hasValue = false
    private processing = false
    private stopped = false
    private command: (value: T) => Promise<void>

    constructor(command: (value: T) => Promise<void>) {
        this.command = command
    }

    setValue(value: T) {
        if (this.stopped) {
            // Reset stopped state - this handles React Strict Mode re-mounting
            this.stopped = false
        }
        this.latestValue = value
        this.hasValue = true
        if (!this.processing) {
            this.processing = true
            this.doSync()
        }
    }

    stop() {
        this.stopped = true
    }

    private async doSync() {
        while (this.hasValue && !this.stopped) {
            const value = this.latestValue!
            this.hasValue = false
            try {
                await this.command(value)
            } catch (e) {
                console.error('ValueSync error:', e)
            }
        }
        this.processing = false
    }
}

/**
 * Hook that manages autocomplete suggestions based on an active word query
 * Returns: [suggestions, selectedIndex, moveUp, moveDown]
 */
export function useActiveSuggestions(
    query: string | null,
    handler: (query: string) => Promise<Suggestion[]>,
    options: SuggestionOptions = {}
) {
    const {
        clampSelection = true,
        autoSelectFirst = true,
        wrapAround = true,
        allowEmptyQuery = false
    } = options

    // State for suggestions
    const [state, setState] = useState<{
        suggestions: Suggestion[]
        selected: number
    }>({
        suggestions: [],
        selected: -1
    })

    const moveUp = useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev

            if (prev.selected <= 0) {
                // At top or nothing selected
                if (wrapAround) {
                    return { ...prev, selected: prev.suggestions.length - 1 }
                } else {
                    return { ...prev, selected: 0 }
                }
            }
            // Move up
            return { ...prev, selected: prev.selected - 1 }
        })
    }, [wrapAround])

    const moveDown = useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev

            if (prev.selected >= prev.suggestions.length - 1) {
                // At bottom
                if (wrapAround) {
                    return { ...prev, selected: 0 }
                } else {
                    return { ...prev, selected: prev.suggestions.length - 1 }
                }
            }
            // If nothing selected, select first
            if (prev.selected < 0) {
                return { ...prev, selected: 0 }
            }
            // Move down
            return { ...prev, selected: prev.selected + 1 }
        })
    }, [wrapAround])

    const clear = useCallback(() => {
        setState({ suggestions: [], selected: -1 })
    }, [])

    // Sync query to suggestions
    const handlerRef = useRef(handler)
    handlerRef.current = handler

    const syncRef = useRef<ValueSync<string | null> | null>(null)

    useEffect(() => {
        const sync = new ValueSync<string | null>(async (nextQuery) => {
            if (nextQuery === null || (!allowEmptyQuery && nextQuery === '')) return

            const suggestions = await handlerRef.current(nextQuery)

            setState((prev) => {
                if (clampSelection) {
                    // Simply clamp the selection to valid range
                    let newSelected = prev.selected

                    if (suggestions.length === 0) {
                        newSelected = -1
                    } else if (autoSelectFirst && prev.suggestions.length === 0) {
                        // First time showing suggestions, auto-select first
                        newSelected = 0
                    } else if (prev.selected >= suggestions.length) {
                        // Selection is out of bounds, clamp to last item
                        newSelected = suggestions.length - 1
                    } else if (prev.selected < 0 && suggestions.length > 0 && autoSelectFirst) {
                        // No selection but we have suggestions
                        newSelected = 0
                    }

                    return { suggestions, selected: newSelected }
                } else {
                    // Try to preserve selection by key (old behavior)
                    if (prev.selected >= 0 && prev.selected < prev.suggestions.length) {
                        const previousKey = prev.suggestions[prev.selected].key
                        const newIndex = suggestions.findIndex(s => s.key === previousKey)
                        if (newIndex !== -1) {
                            // Found the same key, keep it selected
                            return { suggestions, selected: newIndex }
                        }
                    }

                    // Key not found or no previous selection, clamp the selection
                    const clampedSelection = Math.min(prev.selected, suggestions.length - 1)
                    return {
                        suggestions,
                        selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : clampedSelection
                    }
                }
            })
        })

        syncRef.current = sync

        return () => {
            sync.stop()
            if (syncRef.current === sync) {
                syncRef.current = null
            }
        }
    }, [clampSelection, autoSelectFirst, allowEmptyQuery])

    useEffect(() => {
        syncRef.current?.setValue(query)
    }, [query, handler, clampSelection, autoSelectFirst, allowEmptyQuery])

    // If no query return empty suggestions
    if (query === null || (!allowEmptyQuery && query === '')) {
        return [[], -1, moveUp, moveDown, clear] as const
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown, clear] as const
}
