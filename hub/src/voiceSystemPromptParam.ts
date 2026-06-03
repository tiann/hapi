/** Decode ?systemPrompt= from Gemini hub proxy (base64url, UTF-8). */
export function decodeVoiceSystemPromptParam(param: string | null | undefined): string | undefined {
    if (!param?.trim()) return undefined
    try {
        const normalized = param.replace(/-/g, '+').replace(/_/g, '/')
        const pad = '='.repeat((4 - (normalized.length % 4)) % 4)
        const decoded = Buffer.from(normalized + pad, 'base64').toString('utf8')
        if (!decoded.trim() || decoded.length > 48_000) return undefined
        return decoded
    } catch {
        return undefined
    }
}
