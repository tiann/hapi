import type { CliLocalSessionSource } from './types'
import type { LocalSessionFlavor } from '@hapi/protocol/localTranscript'

const sources = new Map<LocalSessionFlavor, CliLocalSessionSource>()

export function registerLocalSessionSource(source: CliLocalSessionSource): void {
    sources.set(source.flavor, source)
}

export function getLocalSessionSource(flavor: LocalSessionFlavor): CliLocalSessionSource | null {
    return sources.get(flavor) ?? null
}

export function listLocalSessionFlavors(): LocalSessionFlavor[] {
    return Array.from(sources.keys())
}

/** Test-only: reset the registry between scenarios. */
export function clearLocalSessionSources(): void {
    sources.clear()
}