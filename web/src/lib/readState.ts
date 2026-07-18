function mediaQueryMatches(query: string): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false
    }
    return window.matchMedia(query).matches
}

function isStandaloneApp(): boolean {
    if (mediaQueryMatches('(display-mode: standalone)')) {
        return true
    }
    if (typeof navigator === 'undefined') {
        return false
    }
    return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function canTreatVisibleDocumentAsActive(): boolean {
    return isStandaloneApp() || mediaQueryMatches('(pointer: coarse)')
}

export function shouldMarkSessionRead(): boolean {
    if (typeof document === 'undefined') {
        return false
    }
    if (document.visibilityState !== 'visible') {
        return false
    }
    if (typeof document.hasFocus === 'function') {
        return document.hasFocus() || canTreatVisibleDocumentAsActive()
    }
    return true
}
