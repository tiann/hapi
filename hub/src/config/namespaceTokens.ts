import { constantTimeEquals } from '../utils/crypto'
import { getSettingsFile, readSettings, writeSettings } from './settings'

const DEFAULT_NAMESPACE = 'default'
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MINIMUM_CREDENTIAL_LENGTH = 16

export type NamespaceTokensResult = {
    tokens: Readonly<Record<string, string>>
    source: 'env' | 'file' | 'default'
    savedToFile: boolean
}

function parseEnvironmentValue(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown
    } catch {
        throw new Error('HAPI_NAMESPACE_TOKENS_JSON must be a JSON object mapping namespaces to credentials')
    }
}

function validateNamespaceTokens(value: unknown, defaultToken: string): Readonly<Record<string, string>> {
    if (value === undefined) {
        return Object.freeze({})
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Namespace credentials must be an object mapping namespaces to credentials')
    }

    const entries = Object.entries(value)
    const tokens: Record<string, string> = {}
    const seenCredentials: string[] = [defaultToken]

    for (const [namespace, rawCredential] of entries) {
        if (namespace === DEFAULT_NAMESPACE) {
            throw new Error(`Namespace '${DEFAULT_NAMESPACE}' is reserved for CLI_API_TOKEN`)
        }
        if (!NAMESPACE_PATTERN.test(namespace)) {
            throw new Error(`Invalid namespace '${namespace}'. Use 1-64 letters, numbers, dots, underscores, or hyphens.`)
        }
        if (typeof rawCredential !== 'string' || rawCredential.trim() !== rawCredential) {
            throw new Error(`Credential for namespace '${namespace}' must be a non-empty string without surrounding whitespace`)
        }
        if (rawCredential.length < MINIMUM_CREDENTIAL_LENGTH) {
            throw new Error(`Credential for namespace '${namespace}' must be at least ${MINIMUM_CREDENTIAL_LENGTH} characters`)
        }
        if (seenCredentials.some((credential) => constantTimeEquals(credential, rawCredential))) {
            throw new Error(`Credential for namespace '${namespace}' duplicates another namespace credential`)
        }

        tokens[namespace] = rawCredential
        seenCredentials.push(rawCredential)
    }

    return Object.freeze(tokens)
}

export async function loadNamespaceTokens(dataDir: string, defaultToken: string): Promise<NamespaceTokensResult> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettings(settingsFile)
    if (settings === null) {
        throw new Error(`Cannot read ${settingsFile}. Please fix or remove the file and restart.`)
    }

    const rawEnvironmentValue = process.env.HAPI_NAMESPACE_TOKENS_JSON
    if (rawEnvironmentValue !== undefined) {
        const tokens = validateNamespaceTokens(parseEnvironmentValue(rawEnvironmentValue), defaultToken)
        let savedToFile = false
        if (settings.namespaceTokens === undefined) {
            settings.namespaceTokens = { ...tokens }
            await writeSettings(settingsFile, settings)
            savedToFile = true
        }
        return { tokens, source: 'env', savedToFile }
    }

    if (settings.namespaceTokens !== undefined) {
        return {
            tokens: validateNamespaceTokens(settings.namespaceTokens, defaultToken),
            source: 'file',
            savedToFile: false,
        }
    }

    return { tokens: Object.freeze({}), source: 'default', savedToFile: false }
}
