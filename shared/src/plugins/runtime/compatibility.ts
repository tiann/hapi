import type { PluginHostInfo } from '../admin'
import type { PluginManifestLite, PluginRuntimeName } from '../manifest'

type RuntimeCompatibilityRecord = {
    manifest?: PluginManifestLite
    status: string
    diagnostics: Array<{
        severity: 'error' | 'warning' | 'info'
        code: string
        message: string
        path?: string
    }>
    manifestPath: string
}

type NumericVersion = [number, number, number]

function parseNumericVersion(version: string): NumericVersion | null {
    const match = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    if (!match) return null
    return [
        Number(match[1]),
        Number(match[2] ?? 0),
        Number(match[3] ?? 0)
    ]
}

function compareVersion(leftRaw: string, rightRaw: string): number | null {
    const left = parseNumericVersion(leftRaw)
    const right = parseNumericVersion(rightRaw)
    if (!left || !right) return null
    for (let index = 0; index < 3; index += 1) {
        if (left[index] > right[index]) return 1
        if (left[index] < right[index]) return -1
    }
    return 0
}

function satisfiesSimpleComparator(version: string, comparator: string): boolean {
    const trimmed = comparator.trim()
    if (!trimmed || trimmed === '*' || trimmed === 'x') return true

    if (trimmed.startsWith('^')) {
        const base = parseNumericVersion(trimmed.slice(1))
        if (!base) return false
        const lower = compareVersion(version, base.join('.'))
        if (lower === null || lower < 0) return false
        const upper: NumericVersion = base[0] === 0
            ? [0, base[1] + 1, 0]
            : [base[0] + 1, 0, 0]
        const upperCompare = compareVersion(version, upper.join('.'))
        return upperCompare !== null && upperCompare < 0
    }

    const match = trimmed.match(/^(<=|>=|<|>|=)?\s*(.+)$/)
    if (!match) return false
    const operator = match[1] ?? '='
    const target = match[2]
    const compare = compareVersion(version, target)
    if (compare === null) return false
    if (operator === '>=') return compare >= 0
    if (operator === '>') return compare > 0
    if (operator === '<=') return compare <= 0
    if (operator === '<') return compare < 0
    return compare === 0
}

export function satisfiesVersionRange(version: string, range: string | undefined): boolean {
    if (!range?.trim()) return true
    return range
        .split('||')
        .some((alternative) => alternative
            .trim()
            .replace(/(<=|>=|<|>|=|\^)\s+/g, '$1')
            .split(/\s+/)
            .filter(Boolean)
            .every((comparator) => satisfiesSimpleComparator(version, comparator)))
}

export function hostSupportedPluginApiVersions(hostInfo: Pick<PluginHostInfo, 'pluginApiVersion' | 'supportedPluginApiVersions'>): string[] {
    return Array.from(new Set([
        hostInfo.pluginApiVersion,
        ...(hostInfo.supportedPluginApiVersions ?? [])
    ].filter(Boolean)))
}

export function pluginRuntimeCompatibilityProblems(manifest: PluginManifestLite, runtime: PluginRuntimeName, hostInfo: PluginHostInfo | undefined): string[] {
    const global = manifest.compatibility
    const runtimeCompatibility = runtime === 'hub' ? global?.hub : global?.runner
    if (!hostInfo) {
        const requiresHostInfo = Boolean(
            global?.hapi
            || global?.pluginApi
            || global?.os?.length
            || global?.arch?.length
            || runtimeCompatibility?.hapi
            || runtimeCompatibility?.pluginApi
            || runtimeCompatibility?.os?.length
            || runtimeCompatibility?.arch?.length
            || runtimeCompatibility?.extensionPoints?.length
        )
        return requiresHostInfo
            ? ['Target did not report plugin host information. Upgrade this Runner before installing plugins with runtime compatibility requirements.']
            : []
    }

    const problems: string[] = []
    const supportedPluginApiVersions = hostSupportedPluginApiVersions(hostInfo)
    if (!supportedPluginApiVersions.includes(manifest.pluginApiVersion)) {
        problems.push(`${runtime} does not support plugin API contract ${manifest.pluginApiVersion}; supported plugin API versions: ${supportedPluginApiVersions.join(', ')}.`)
    }
    const hapiRanges = [global?.hapi, runtimeCompatibility?.hapi].filter((entry): entry is string => Boolean(entry))
    for (const range of hapiRanges) {
        if (!satisfiesVersionRange(hostInfo.hapiVersion, range)) {
            problems.push(`${runtime} HAPI version ${hostInfo.hapiVersion} does not satisfy ${range}.`)
        }
    }
    const pluginApiRanges = [global?.pluginApi, runtimeCompatibility?.pluginApi].filter((entry): entry is string => Boolean(entry))
    for (const range of pluginApiRanges) {
        if (!supportedPluginApiVersions.some((version) => satisfiesVersionRange(version, range))) {
            problems.push(`${runtime} supported plugin API versions ${supportedPluginApiVersions.join(', ')} do not satisfy ${range}.`)
        }
    }
    const osLists = [global?.os, runtimeCompatibility?.os].filter((entry): entry is Array<'darwin' | 'linux' | 'win32'> => Boolean(entry))
    for (const osList of osLists) {
        if (!osList.includes(hostInfo.os as 'darwin' | 'linux' | 'win32')) {
            problems.push(`${runtime} OS ${hostInfo.os} is not in supported OS list: ${osList.join(', ')}.`)
        }
    }
    const archLists = [global?.arch, runtimeCompatibility?.arch].filter((entry): entry is string[] => Boolean(entry))
    for (const archList of archLists) {
        if (!archList.includes(hostInfo.arch)) {
            problems.push(`${runtime} arch ${hostInfo.arch} is not in supported arch list: ${archList.join(', ')}.`)
        }
    }
    const extensionPoints = runtimeCompatibility?.extensionPoints ?? []
    const supported = new Set(hostInfo.supportedExtensionPoints)
    for (const extensionPoint of extensionPoints) {
        if (!supported.has(extensionPoint)) {
            problems.push(`${runtime} does not support extension point ${extensionPoint}.`)
        }
    }
    return problems
}

export function applyRuntimeCompatibility<T extends RuntimeCompatibilityRecord>(
    records: T[],
    runtime: Extract<PluginRuntimeName, 'hub' | 'runner'>,
    hostInfo: PluginHostInfo
): T[] {
    return records.map((record) => {
        if (!record.manifest || record.status !== 'validated') {
            return record
        }
        const problems = pluginRuntimeCompatibilityProblems(record.manifest, runtime, hostInfo)
        if (problems.length === 0) {
            return record
        }
        return {
            ...record,
            status: 'incompatible',
            diagnostics: [
                ...record.diagnostics,
                {
                    severity: 'error' as const,
                    code: 'runtime-incompatible',
                    message: problems.join(' '),
                    path: record.manifestPath
                }
            ]
        } as T
    })
}
