import { useCallback, useEffect, useState } from 'react'
import {
    AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    AUTO_TEXT_CONTEXT_LINE_THRESHOLD,
} from '@/lib/textContext'

export const MIN_TEXT_CONTEXT_CHARACTER_THRESHOLD = 100
export const MAX_TEXT_CONTEXT_CHARACTER_THRESHOLD = 100_000
export const MIN_TEXT_CONTEXT_LINE_THRESHOLD = 1
export const MAX_TEXT_CONTEXT_LINE_THRESHOLD = 1_000

const CHARACTER_STORAGE_KEY = 'hapi-text-context-character-threshold'
const LINE_STORAGE_KEY = 'hapi-text-context-line-threshold'
const CHANGE_EVENT = 'hapi-text-context-thresholds-changed'

type TextContextThresholds = {
    characterThreshold: number
    lineThreshold: number
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Keep the in-memory preference when storage is unavailable.
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Keep the in-memory preference when storage is unavailable.
    }
}

function normalizeInteger(
    value: number,
    min: number,
    max: number,
    fallback: number,
): number {
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
}

export function normalizeTextContextCharacterThreshold(value: number): number {
    return normalizeInteger(
        value,
        MIN_TEXT_CONTEXT_CHARACTER_THRESHOLD,
        MAX_TEXT_CONTEXT_CHARACTER_THRESHOLD,
        AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    )
}

export function normalizeTextContextLineThreshold(value: number): number {
    return normalizeInteger(
        value,
        MIN_TEXT_CONTEXT_LINE_THRESHOLD,
        MAX_TEXT_CONTEXT_LINE_THRESHOLD,
        AUTO_TEXT_CONTEXT_LINE_THRESHOLD,
    )
}

function parseStoredThreshold(
    raw: string | null,
    normalize: (value: number) => number,
    fallback: number,
): number {
    if (raw == null || raw.trim() === '') return fallback
    return normalize(Number(raw))
}

export function getInitialTextContextThresholds(): TextContextThresholds {
    return {
        characterThreshold: parseStoredThreshold(
            safeGetItem(CHARACTER_STORAGE_KEY),
            normalizeTextContextCharacterThreshold,
            AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD,
        ),
        lineThreshold: parseStoredThreshold(
            safeGetItem(LINE_STORAGE_KEY),
            normalizeTextContextLineThreshold,
            AUTO_TEXT_CONTEXT_LINE_THRESHOLD,
        ),
    }
}

function persistThreshold(
    key: string,
    value: number,
    defaultValue: number,
): void {
    if (value === defaultValue) {
        safeRemoveItem(key)
    } else {
        safeSetItem(key, String(value))
    }
}

export function useTextContextPreferences(): TextContextThresholds & {
    setCharacterThreshold: (value: number) => void
    setLineThreshold: (value: number) => void
} {
    const [thresholds, setThresholds] = useState<TextContextThresholds>(
        getInitialTextContextThresholds,
    )

    useEffect(() => {
        if (!isBrowser()) return

        const refresh = () => setThresholds(getInitialTextContextThresholds())
        const onStorage = (event: StorageEvent) => {
            if (
                event.key !== CHARACTER_STORAGE_KEY
                && event.key !== LINE_STORAGE_KEY
            ) {
                return
            }
            refresh()
        }
        const onLocalChange = (event: Event) => {
            const detail = event instanceof CustomEvent ? event.detail : null
            if (
                detail
                && typeof detail === 'object'
                && typeof detail.characterThreshold === 'number'
                && typeof detail.lineThreshold === 'number'
            ) {
                setThresholds(detail as TextContextThresholds)
            }
        }

        window.addEventListener('storage', onStorage)
        window.addEventListener(CHANGE_EVENT, onLocalChange)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(CHANGE_EVENT, onLocalChange)
        }
    }, [])

    const update = useCallback((next: TextContextThresholds) => {
        setThresholds(next)
        persistThreshold(
            CHARACTER_STORAGE_KEY,
            next.characterThreshold,
            AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD,
        )
        persistThreshold(
            LINE_STORAGE_KEY,
            next.lineThreshold,
            AUTO_TEXT_CONTEXT_LINE_THRESHOLD,
        )
        if (isBrowser()) {
            window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }))
        }
    }, [])

    const setCharacterThreshold = useCallback((value: number) => {
        update({
            ...thresholds,
            characterThreshold: normalizeTextContextCharacterThreshold(value),
        })
    }, [thresholds, update])

    const setLineThreshold = useCallback((value: number) => {
        update({
            ...thresholds,
            lineThreshold: normalizeTextContextLineThreshold(value),
        })
    }, [thresholds, update])

    return {
        ...thresholds,
        setCharacterThreshold,
        setLineThreshold,
    }
}
