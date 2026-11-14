import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
    cleanup()
})

// Node 25+ exposes its own Web Storage globals, which shadow jsdom's. Tests spy on
// Storage.prototype and pass localStorage to StorageEvent, so both must be jsdom's.
const jsdomWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window
for (const name of ['localStorage', 'sessionStorage'] as const) {
    const storage = jsdomWindow[name]
    Object.defineProperty(globalThis, name, { value: storage, configurable: true })
    Object.defineProperty(window, name, { value: storage, configurable: true })
}

if (!('IntersectionObserver' in globalThis)) {
    class MockIntersectionObserver implements IntersectionObserver {
        readonly root = null
        readonly rootMargin = ''
        readonly thresholds = []

        disconnect() {}
        observe() {}
        takeRecords(): IntersectionObserverEntry[] { return [] }
        unobserve() {}
    }

    Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
    Object.defineProperty(window, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
}

if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        }),
    })
}
