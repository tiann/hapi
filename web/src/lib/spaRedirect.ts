const SPA_REDIRECT_KEY = 'spaRedirect'

/**
 * Stores the current path in sessionStorage before GitHub Pages redirects to /.
 * Called from public/404.html when GitHub Pages serves a 404 for SPA routes.
 */
export function storeSpaRedirect(): void {
    const path = window.location.pathname + window.location.search + window.location.hash
    sessionStorage.setItem(SPA_REDIRECT_KEY, path)
}

/**
 * Restores the path stored by storeSpaRedirect() using replaceState,
 * so TanStack Router initializes at the correct URL without a server round-trip.
 */
export function restoreSpaRedirect(): void {
    const redirect = sessionStorage.getItem(SPA_REDIRECT_KEY)
    if (redirect) {
        sessionStorage.removeItem(SPA_REDIRECT_KEY)
        window.history.replaceState(null, '', redirect)
    }
}
