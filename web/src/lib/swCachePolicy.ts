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
