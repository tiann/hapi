import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    HUB_IMPLEMENTED_EXTENSION_POINTS,
    RUNNER_IMPLEMENTED_EXTENSION_POINTS,
    SCHEMA_ONLY_EXTENSION_POINTS
} from '@hapi/protocol/plugins/extensionPoints'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const scannedRoots = ['hub/src', 'web/src', 'cli/src']
const excludedSuffixes = [
    '.test.ts',
    '.test.tsx',
    '.spec.ts',
    '.spec.tsx'
]

type SourceFile = {
    path: string
    rel: string
    text: string
}

type SourcePluginManifest = {
    id: string
    name?: string
    capabilities?: Array<{
        id?: string
        displayName?: string
    }>
    permissions?: {
        secrets?: string[]
    }
    contributions?: {
        hub?: {
            notificationChannels?: Array<{ id?: string; displayName?: string }>
            messageActions?: Array<{ id?: string; displayName?: string }>
        }
        runner?: Record<string, Array<{ id?: string; displayName?: string }> | undefined>
        agent?: Record<string, Array<{ id?: string; displayName?: string }> | undefined>
        web?: Record<string, Array<{ id?: string; displayName?: string }> | undefined>
    }
}

function sourceFiles(root: string): string[] {
    const result: string[] = []
    const visit = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry)
            const stat = statSync(path)
            if (stat.isDirectory()) {
                if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue
                visit(path)
                continue
            }
            if (!/\.(ts|tsx)$/.test(entry)) continue
            if (excludedSuffixes.some((suffix) => entry.endsWith(suffix))) continue
            result.push(path)
        }
    }
    visit(join(repoRoot, root))
    return result
}

function readScannedFiles(): SourceFile[] {
    return scannedRoots.flatMap(sourceFiles).map((path) => ({
        path,
        rel: relative(repoRoot, path),
        text: readFileSync(path, 'utf8')
    }))
}

function readSourcePluginManifests(): SourcePluginManifest[] {
    const pluginsRoot = join(repoRoot, 'plugins')
    if (!existsSync(pluginsRoot)) return []
    return readdirSync(pluginsRoot)
        .map((entry) => join(pluginsRoot, entry, 'hapi.plugin.json'))
        .filter((path) => existsSync(path))
        .map((path) => JSON.parse(readFileSync(path, 'utf8')) as SourcePluginManifest)
}

function collectContributionIds(manifest: SourcePluginManifest): string[] {
    const ids = new Set<string>()
    const collectGroup = (group: Record<string, Array<{ id?: string }> | undefined> | undefined) => {
        if (!group) return
        for (const entries of Object.values(group)) {
            for (const entry of entries ?? []) {
                if (typeof entry.id === 'string' && entry.id.trim()) {
                    ids.add(entry.id)
                }
            }
        }
    }
    collectGroup(manifest.contributions?.hub)
    collectGroup(manifest.contributions?.runner)
    collectGroup(manifest.contributions?.agent)
    collectGroup(manifest.contributions?.web)
    return Array.from(ids)
}

function collectGuardrailTerms(manifest: SourcePluginManifest): string[] {
    const terms = new Set<string>()
    const add = (value: unknown) => {
        if (typeof value === 'string' && value.trim().length >= 3) {
            terms.add(value.trim())
        }
    }
    const collectContributionGroup = (group: Record<string, Array<{ id?: string; displayName?: string }> | undefined> | undefined) => {
        if (!group) return
        for (const entries of Object.values(group)) {
            for (const entry of entries ?? []) {
                add(entry.id)
                add(entry.displayName)
            }
        }
    }

    add(manifest.id)
    add(manifest.name)
    for (const capability of manifest.capabilities ?? []) {
        add(capability.id)
        add(capability.displayName)
    }
    for (const secret of manifest.permissions?.secrets ?? []) {
        add(secret)
    }
    collectContributionGroup(manifest.contributions?.hub)
    collectContributionGroup(manifest.contributions?.runner)
    collectContributionGroup(manifest.contributions?.agent)
    collectContributionGroup(manifest.contributions?.web)
    return Array.from(terms)
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function offendersFor(pattern: RegExp): string[] {
    return readScannedFiles()
        .filter((file) => pattern.test(file.text))
        .map((file) => file.rel)
}

describe('plugin architecture boundaries', () => {
    it('does not hard-code source plugin identities, names, secrets, or contribution ids in core runtime or Web code', () => {
        const manifests = readSourcePluginManifests()
        const forbiddenTerms = Array.from(new Set(manifests.flatMap(collectGuardrailTerms)))
            .sort((left, right) => right.length - left.length)
        expect(forbiddenTerms).not.toEqual([])

        const forbidden = new RegExp(forbiddenTerms.map(escapeRegex).join('|'), 'i')
        expect(offendersFor(forbidden)).toEqual([])
    })

    it('does not branch on literal plugin identities for any plugin', () => {
        const literal = String.raw`['"](?!(?:string|number|boolean|object|function|undefined|symbol|bigint)['"])[^'"]+['"]`
        const pluginIdExpression = String.raw`\b(?:pluginId|plugin\.id|plugin\.manifest\.id|record\.manifest\.id|manifest\.id)`
        const forbidden = new RegExp(`${pluginIdExpression}\\s*(?:={2,3}|!={1,2})\\s*${literal}|${literal}\\s*(?:={2,3}|!={1,2})\\s*${pluginIdExpression}`)
        expect(offendersFor(forbidden)).toEqual([])
    })

    it('does not hide plugin-specific branches in literal sets, arrays, or maps', () => {
        const pluginIdExpression = String.raw`(?:pluginId|plugin\.id|plugin\.manifest\.id|record\.manifest\.id|manifest\.id)`
        const literalList = String.raw`\[[^\]]*['"][^'"]+['"][^\]]*\]`
        const nestedLiteralList = String.raw`\[[\s\S]{0,300}['"][^'"]+['"][\s\S]{0,300}\]`
        const literalObject = String.raw`\{[^}]*['"][^'"]+['"]\s*:`
        const forbidden = new RegExp([
            String.raw`new\s+Set\s*\(\s*${literalList}\s*\)\.has\s*\(\s*${pluginIdExpression}\s*\)`,
            String.raw`${literalList}\.includes\s*\(\s*${pluginIdExpression}\s*\)`,
            String.raw`${literalObject}[^}]*\}\s*\[\s*${pluginIdExpression}\s*\]`,
            String.raw`new\s+Map\s*\(\s*${nestedLiteralList}\s*\)\.has\s*\(\s*${pluginIdExpression}\s*\)`,
            String.raw`switch\s*\(\s*${pluginIdExpression}\s*\)\s*\{[\s\S]{0,300}case\s+['"][^'"]+['"]`
        ].join('|'))
        expect(offendersFor(forbidden)).toEqual([])
    })

    it('does not define plugin-specific core constants in app packages', () => {
        const forbidden = /\bHAPI_[A-Z0-9_]+_PLUGIN_ID\b/
        expect(offendersFor(forbidden)).toEqual([])
    })

    it('does not expose plugin-specific core APIs for source plugin contributions', () => {
        const manifests = readSourcePluginManifests()
        const ids = Array.from(new Set(manifests.flatMap(collectContributionIds))).sort((left, right) => right.length - left.length)
        expect(ids).not.toEqual([])

        const routeLiteral = new RegExp(String.raw`['\"][^'\"]*(?:${ids.map(escapeRegex).join('|')})[^'\"]*['\"]`, 'i')
        expect(offendersFor(routeLiteral)).toEqual([])
    })

    it('keeps implemented extension points scoped to actual runtimes', () => {
        expect(HUB_IMPLEMENTED_EXTENSION_POINTS).not.toContain('hub.action')
        expect(RUNNER_IMPLEMENTED_EXTENSION_POINTS).not.toContain('hub.action')
        for (const extensionPoint of SCHEMA_ONLY_EXTENSION_POINTS) {
            expect(HUB_IMPLEMENTED_EXTENSION_POINTS).not.toContain(extensionPoint)
            expect(RUNNER_IMPLEMENTED_EXTENSION_POINTS).not.toContain(extensionPoint)
        }
    })
})
