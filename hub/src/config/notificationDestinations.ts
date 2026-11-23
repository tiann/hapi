import { DEFAULT_NAMESPACE } from '../utils/accessToken'

export type WxPusherDestination = {
    appToken: string
    uids: string[]
    topicIds: number[]
    backgroundOnly: boolean
}

export function readDestinationObject(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${field} must be an object`)
    }
    return value as Record<string, unknown>
}

export function readNamespaceDestinations<T>(
    value: unknown,
    field: string,
    readEntry: (entry: Record<string, unknown>, field: string) => T
): Map<string, T> {
    const destinations = new Map<string, T>()
    if (value === undefined) return destinations
    for (const [namespace, entry] of Object.entries(readDestinationObject(value, field))) {
        if (!namespace || namespace.trim() !== namespace || namespace.includes(':')) {
            throw new Error(`${field} contains an invalid namespace key`)
        }
        const entryField = `${field} entry for namespace ${JSON.stringify(namespace)}`
        destinations.set(namespace, readEntry(readDestinationObject(entry, entryField), entryField))
    }
    return destinations
}

export function setLegacyDefaultDestination<T>(destinations: Map<string, T>, legacy: T | null): void {
    if (legacy !== null && !destinations.has(DEFAULT_NAMESPACE)) {
        destinations.set(DEFAULT_NAMESPACE, legacy)
    }
}

export function readDestinationCredential(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} must be a non-empty string`)
    }
    return value.trim()
}

export function readDestinationBackgroundOnly(value: unknown, field: string): boolean {
    if (value === undefined) return false
    if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
    return value
}
