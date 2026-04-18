import '@testing-library/jest-dom/vitest'

function createMemoryStorage(): Storage {
    const values = new Map<string, string>()

    return {
        get length() {
            return values.size
        },
        key(index: number) {
            return Array.from(values.keys())[index] ?? null
        },
        getItem(key: string) {
            return values.get(key) ?? null
        },
        setItem(key: string, value: string) {
            values.set(key, value)
        },
        removeItem(key: string) {
            values.delete(key)
        },
        clear() {
            values.clear()
        }
    }
}

function getLocalStorage(): Storage | null {
    try {
        return window.localStorage
    } catch {
        return null
    }
}

const localStorageCandidate = getLocalStorage()
if (
    !localStorageCandidate
    || typeof localStorageCandidate.getItem !== 'function'
    || typeof localStorageCandidate.setItem !== 'function'
    || typeof localStorageCandidate.removeItem !== 'function'
    || typeof localStorageCandidate.clear !== 'function'
) {
    const memoryStorage = createMemoryStorage()
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: memoryStorage
    })
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: memoryStorage
    })
}
