/**
 * Web Share Target paths must respect Vite `base` so subpath deployments
 * (e.g. GitHub Pages at `/<repo>/`) keep the POST action inside the PWA
 * scope and under the service worker's control.
 */

const RESOLVE_ORIGIN = 'https://hapi.local/'

/** Build the share-target pathname from an explicit Vite base (build-time). */
export function shareTargetPathnameFromBase(baseUrl: string): string {
    const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    return new URL('share', new URL(normalized, RESOLVE_ORIGIN)).pathname
}

/** Share-target pathname for the current bundle (`import.meta.env.BASE_URL`). */
export function shareTargetPathname(): string {
    return shareTargetPathnameFromBase(import.meta.env.BASE_URL)
}
