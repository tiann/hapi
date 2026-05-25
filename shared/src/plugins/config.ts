export type UnsafePluginConfigReason = 'declared-secret' | 'secret-shaped-key' | 'redacted-placeholder'

export type UnsafePluginConfigPath = {
    path: string
    reason: UnsafePluginConfigReason
    key?: string
}

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSecretShapedKey(key: string): boolean {
    const normalized = normalizeKey(key)
    return normalized.includes('secret')
        || normalized.includes('token')
        || normalized.includes('password')
        || normalized.includes('passphrase')
        || normalized.includes('credential')
        || normalized.includes('apikey')
        || normalized.includes('privatekey')
        || normalized.includes('accesskey')
}

export function findUnsafePluginConfigPath(
    value: unknown,
    declaredSecrets: string[] = [],
    path = '$'
): UnsafePluginConfigPath | null {
    if (value === '[REDACTED]') {
        return { path, reason: 'redacted-placeholder' }
    }

    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = findUnsafePluginConfigPath(value[index], declaredSecrets, `${path}[${index}]`)
            if (found) return found
        }
        return null
    }

    if (!value || typeof value !== 'object') {
        return null
    }

    const declared = new Set(declaredSecrets.map(normalizeKey))
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const nextPath = `${path}.${key}`
        const normalizedKey = normalizeKey(key)
        if (declared.has(normalizedKey)) {
            return { path: nextPath, reason: 'declared-secret', key }
        }
        if (isSecretShapedKey(key)) {
            return { path: nextPath, reason: 'secret-shaped-key', key }
        }
        const found = findUnsafePluginConfigPath(entry, declaredSecrets, nextPath)
        if (found) return found
    }

    return null
}

export function assertPluginConfigSafeForPersistence(
    config: Record<string, unknown> | undefined,
    declaredSecrets: string[] = [],
    pluginId = 'plugin'
): void {
    if (!config) return

    const unsafe = findUnsafePluginConfigPath(config, declaredSecrets)
    if (!unsafe) return

    if (unsafe.reason === 'redacted-placeholder') {
        throw new Error(`Config for ${pluginId} contains a redacted placeholder at ${unsafe.path}; replace it with a real value or remove the field before saving.`)
    }
    if (unsafe.reason === 'declared-secret') {
        throw new Error(`Config for ${pluginId} must not store declared secret ${unsafe.key ?? unsafe.path}; set it as an environment variable instead.`)
    }
    throw new Error(`Config for ${pluginId} must not store secret-like field ${unsafe.key ?? unsafe.path}; set secrets as environment variables instead.`)
}

export function sanitizePluginConfigForView(
    config: Record<string, unknown> | undefined,
    declaredSecrets: string[] = []
): Record<string, unknown> | undefined {
    if (!config) return undefined

    const declared = new Set(declaredSecrets.map(normalizeKey))
    const sanitize = (value: unknown, key = ''): unknown => {
        const normalizedKey = normalizeKey(key)
        if (key && (declared.has(normalizedKey) || isSecretShapedKey(key))) {
            return '[REDACTED]'
        }
        if (Array.isArray(value)) {
            return value.map((entry) => sanitize(entry))
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, sanitize(entry, entryKey)]))
        }
        return value
    }

    return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, sanitize(value, key)]))
}
