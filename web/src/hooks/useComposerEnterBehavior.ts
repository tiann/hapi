import { useCallback, useEffect, useState } from 'react'

export type ComposerEnterBehavior = 'send' | 'newline'

export const DEFAULT_COMPOSER_ENTER_BEHAVIOR: ComposerEnterBehavior = 'send'

export function getComposerEnterBehaviorOptions(): ReadonlyArray<{ value: ComposerEnterBehavior; labelKey: string }> {
    return [
        { value: 'send', labelKey: 'settings.chat.enterBehavior.send' },
        { value: 'newline', labelKey: 'settings.chat.enterBehavior.newline' },
    ]
}

function getComposerEnterBehaviorStorageKey(): string {
    return 'hapi-composer-enter-behavior'
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

function parseComposerEnterBehavior(raw: string | null): ComposerEnterBehavior {
    if (raw === 'send' || raw === 'newline') {
        return raw
    }
    return DEFAULT_COMPOSER_ENTER_BEHAVIOR
}

export function getInitialComposerEnterBehavior(): ComposerEnterBehavior {
    return parseComposerEnterBehavior(safeGetItem(getComposerEnterBehaviorStorageKey()))
}

export function useComposerEnterBehavior(): {
    composerEnterBehavior: ComposerEnterBehavior
    setComposerEnterBehavior: (behavior: ComposerEnterBehavior) => void
} {
    const [composerEnterBehavior, setComposerEnterBehaviorState] = useState<ComposerEnterBehavior>(getInitialComposerEnterBehavior)

    useEffect(() => {
        if (!isBrowser()) {
            return
        }

        const onStorage = (event: StorageEvent) => {
            if (event.key !== getComposerEnterBehaviorStorageKey()) {
                return
            }
            setComposerEnterBehaviorState(parseComposerEnterBehavior(event.newValue))
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setComposerEnterBehavior = useCallback((behavior: ComposerEnterBehavior) => {
        setComposerEnterBehaviorState(behavior)

        if (behavior === DEFAULT_COMPOSER_ENTER_BEHAVIOR) {
            safeRemoveItem(getComposerEnterBehaviorStorageKey())
        } else {
            safeSetItem(getComposerEnterBehaviorStorageKey(), behavior)
        }
    }, [])

    return { composerEnterBehavior, setComposerEnterBehavior }
}
