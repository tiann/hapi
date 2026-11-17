/**
 * Runtime-cache policy for the API routes, which receive `redirect: 'manual'` requests.
 * - NetworkFirst caches status 0 by default, so a gateway's opaqueredirect would overwrite
 *   the last good JSON. Only 200s are stored.
 * - Fetch makes a service-worker response with redirect history a network error for
 *   non-`follow` requests, so redirected 200s are re-wrapped when stored and when served.
 */
async function withoutRedirectHistory(response: Response): Promise<Response> {
    if (!response.redirected) {
        return response
    }
    return new Response(await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    })
}

export const cacheOkResponsesOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        response.status === 200 ? await withoutRedirectHistory(response) : null,
    cachedResponseWillBeUsed: async (
        { cachedResponse }: { cachedResponse?: Response }
    ): Promise<Response | null> =>
        cachedResponse ? await withoutRedirectHistory(cachedResponse) : null,
}

function hasExpectedContentType(response: Response, pattern: RegExp): boolean {
    if (response.status !== 200 || response.redirected) {
        return false
    }
    return pattern.test(response.headers.get('content-type') ?? '')
}

/** Never cache an SSO login page or redirect in place of a syntax or lazy JS module. */
export const cacheJavaScriptOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        hasExpectedContentType(response, /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i)
            ? response
            : null,
}

/** Never cache an SSO login page or redirect in place of a stylesheet asset. */
export const cacheCssOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        hasExpectedContentType(response, /^text\/css(?:;|$)/i)
            ? response
            : null,
}

/** Never cache an SSO login page or redirect in place of a webfont asset. */
export const cacheFontOnly = {
    cacheWillUpdate: async ({ response }: { response: Response }): Promise<Response | null> =>
        hasExpectedContentType(response, /^(?:font\/woff2?|application\/(?:font-woff2?|x-font-woff2?|octet-stream))(?:;|$)/i)
            ? response
            : null,
}
