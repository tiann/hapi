export function readCodexProviderConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.HAPI_CODEX_PROVIDER_ARGS
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
            ? parsed
            : []
    } catch {
        return []
    }
}
