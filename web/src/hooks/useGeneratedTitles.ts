import { useState } from 'react'

const GENERATED_TITLES_KEY = 'hapi:generated-titles-enabled'

function readGeneratedTitlesPreference(): boolean {
    if (typeof window === 'undefined') return true
    try {
        return localStorage.getItem(GENERATED_TITLES_KEY) !== 'false'
    } catch {
        return true
    }
}

export function useGeneratedTitles(): {
    generatedTitlesEnabled: boolean
    setGeneratedTitlesEnabled: (enabled: boolean) => void
} {
    const [generatedTitlesEnabled, setGeneratedTitlesEnabledState] = useState<boolean>(() => readGeneratedTitlesPreference())

    const setGeneratedTitlesEnabled = (enabled: boolean) => {
        setGeneratedTitlesEnabledState(enabled)
        try {
            localStorage.setItem(GENERATED_TITLES_KEY, enabled ? 'true' : 'false')
        } catch {
            // Ignore storage errors
        }
    }

    return {
        generatedTitlesEnabled,
        setGeneratedTitlesEnabled
    }
}
