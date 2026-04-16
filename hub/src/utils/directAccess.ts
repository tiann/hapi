export function buildTokenizedUrl(baseUrl: string, token: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set('token', token)
    return url.toString()
}

export function buildRelayDirectAccessUrl(webUrl: string, hubUrl: string, token: string): string {
    const url = new URL(webUrl)
    url.searchParams.set('hub', hubUrl)
    url.searchParams.set('token', token)
    return url.toString()
}
