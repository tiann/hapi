import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
    if (typeof document === 'undefined') {
        return () => {}
    }

    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
}

function getSnapshot(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/** Track whether the current document is visible to the user. */
export function useDocumentVisibility(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, () => true)
}
