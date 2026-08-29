export function requireWebhookHttpUrl(url: string, label = 'Webhook URL'): string {
    const trimmed = url.trim()
    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        throw new Error(`${label} must be a valid http(s) URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must be a valid http(s) URL`)
    }
    return trimmed
}
