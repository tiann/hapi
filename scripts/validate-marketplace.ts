#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PluginMarketplaceCatalogSchema, type PluginMarketplaceCatalog } from '@hapi/protocol/plugins/marketplace'

const repoRoot = join(import.meta.dir, '..')
const catalogPath = join(repoRoot, 'marketplace/catalog.v1.json')

function issue(path: string, message: string): string {
    return `${path}: ${message}`
}

function isGitHubReleaseAsset(url: string, repo: string): boolean {
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:'
            && parsed.hostname === 'github.com'
            && parsed.pathname.startsWith(`/${repo}/releases/download/`)
    } catch {
        return false
    }
}

function validateCatalogPolicy(catalog: PluginMarketplaceCatalog): string[] {
    const problems: string[] = []
    for (const [pluginIndex, plugin] of catalog.plugins.entries()) {
        const versions = new Set<string>()
        for (const [releaseIndex, release] of plugin.releases.entries()) {
            const prefix = `plugins[${pluginIndex}].releases[${releaseIndex}]`
            if (versions.has(release.version)) {
                problems.push(issue(`${prefix}.version`, `duplicate release version ${release.version}`))
            }
            versions.add(release.version)

            if (release.package) {
                if (!isGitHubReleaseAsset(release.package.url, plugin.repo)) {
                    problems.push(issue(`${prefix}.package.url`, `must be a GitHub Release asset under https://github.com/${plugin.repo}/releases/download/...`))
                }

                const filename = basename(release.package.filename)
                if (filename !== release.package.filename) {
                    problems.push(issue(`${prefix}.package.filename`, 'must be a basename, not a path'))
                }
                if (release.package.format === 'zip' && !filename.toLowerCase().endsWith('.zip')) {
                    problems.push(issue(`${prefix}.package.filename`, 'zip packages must end in .zip'))
                }
                if (release.package.format === 'tgz' && !/\.(?:tgz|tar\.gz)$/i.test(filename)) {
                    problems.push(issue(`${prefix}.package.filename`, 'tgz packages must end in .tgz or .tar.gz'))
                }
            }

            if (release.source) {
                const normalizedPath = release.source.path.replace(/\\/g, '/')
                if (!normalizedPath.startsWith('plugins/')) {
                    problems.push(issue(`${prefix}.source.path`, 'HAPI source plugins must live under plugins/'))
                }
                if (normalizedPath.startsWith('/') || normalizedPath.split('/').some((part) => part === '..')) {
                    problems.push(issue(`${prefix}.source.path`, 'must be a relative path without traversal segments'))
                }
                if (!release.source.treeChecksum) {
                    problems.push(issue(`${prefix}.source.treeChecksum`, 'is required for HAPI source plugins'))
                }
            }
        }
    }
    return problems
}

async function main(): Promise<void> {
    let raw: string
    try {
        raw = await readFile(catalogPath, 'utf8')
    } catch (err) {
        console.error(`[marketplace:validate] Failed to read ${catalogPath}: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
    }

    let parsedJson: unknown
    try {
        parsedJson = JSON.parse(raw)
    } catch (err) {
        console.error(`[marketplace:validate] Catalog JSON is invalid: ${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
    }

    const parsed = PluginMarketplaceCatalogSchema.safeParse(parsedJson)
    if (!parsed.success) {
        console.error('[marketplace:validate] Catalog schema validation failed:')
        for (const problem of parsed.error.issues) {
            console.error(`  - ${problem.path.join('.') || '(root)'}: ${problem.message}`)
        }
        process.exit(1)
    }

    const policyProblems = validateCatalogPolicy(parsed.data)
    if (policyProblems.length > 0) {
        console.error('[marketplace:validate] Catalog policy validation failed:')
        for (const problem of policyProblems) {
            console.error(`  - ${problem}`)
        }
        process.exit(1)
    }

    console.log(`[marketplace:validate] OK: ${parsed.data.plugins.length} plugin entries.`)
}

await main()
