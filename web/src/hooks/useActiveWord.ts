import { useMemo } from 'react'
import { findActiveWord } from '@/utils/findActiveWord'

/**
 * Hook that detects the active word at the cursor position
 * Returns the active word string if cursor is on a word starting with one of the prefixes
 */
export function useActiveWord(
    text: string,
    selection: { start: number; end: number },
    prefixes: string[] = ['@', '/']
) {
    return useMemo(() => {
        const w = findActiveWord(text, selection, prefixes)
        if (w) {
            return w.activeWord
        }
        return null
    }, [text, selection.start, selection.end, prefixes])
}
