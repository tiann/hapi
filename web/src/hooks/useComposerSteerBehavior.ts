import { useCallback, useEffect, useState } from 'react'

/**
 * What happens to a message sent while the agent is still working on the
 * previous one. 'queue' waits for the current turn to finish (the historical
 * behaviour); 'steer' hands it to the running turn, which the agent picks up
 * at its next step boundary.
 *
 * This is the default for the composer's primary send shortcut; the secondary
 * shortcut always sends the other one. Mirrors useComposerEnterBehavior:
 * localStorage-backed, cross-tab synced, default value stored as absence.
 */
export type ComposerSteerBehavior = 'queue' | 'steer'

export const DEFAULT_COMPOSER_STEER_BEHAVIOR: ComposerSteerBehavior = 'queue'

export function getComposerSteerBehaviorOptions(): ReadonlyArray<{ value: ComposerSteerBehavior; labelKey: string }> {
    return [
        { value: 'queue', labelKey: 'settings.chat.steerBehavior.queue' },
        { value: 'steer', labelKey: 'settings.chat.steerBehavior.steer' },
    ]
}

export function oppositeComposerSteerBehavior(behavior: ComposerSteerBehavior): ComposerSteerBehavior {
    return behavior === 'steer' ? 'queue' : 'steer'
}

function getComposerSteerBehaviorStorageKey(): string {
    return 'hapi-composer-steer-behavior'
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) {
        return null
    }
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) {
        return
    }
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function parseComposerSteerBehavior(raw: string | null): ComposerSteerBehavior {
    if (raw === 'queue' || raw === 'steer') {
        return raw
    }
    return DEFAULT_COMPOSER_STEER_BEHAVIOR
}

export function getInitialComposerSteerBehavior(): ComposerSteerBehavior {
    return parseComposerSteerBehavior(safeGetItem(getComposerSteerBehaviorStorageKey()))
}

export function useComposerSteerBehavior(): {
    composerSteerBehavior: ComposerSteerBehavior
    setComposerSteerBehavior: (behavior: ComposerSteerBehavior) => void
} {
    const [composerSteerBehavior, setComposerSteerBehaviorState] = useState<ComposerSteerBehavior>(getInitialComposerSteerBehavior)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getComposerSteerBehaviorStorageKey()) {
                return
            }
            setComposerSteerBehaviorState(parseComposerSteerBehavior(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setComposerSteerBehavior = useCallback((behavior: ComposerSteerBehavior) => {
        setComposerSteerBehaviorState(behavior)

        if (behavior === DEFAULT_COMPOSER_STEER_BEHAVIOR) {
            safeRemoveItem(getComposerSteerBehaviorStorageKey())
        } else {
            safeSetItem(getComposerSteerBehaviorStorageKey(), behavior)
        }
    }, [])

    return { composerSteerBehavior, setComposerSteerBehavior }
}
