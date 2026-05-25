#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const marketplaceRoot = join(repoRoot, 'marketplace')
const pluginsRoot = join(repoRoot, 'plugins')
const sourceRoots = ['cli/src', 'hub/src', 'shared/src', 'web/src'].map((entry) => join(repoRoot, entry))

function toPosix(path: string): string {
    return path.split(sep).join('/')
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function walkFiles(root: string): string[] {
    if (!existsSync(root)) {
        return []
    }
    const files: string[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const fullPath = join(root, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
                files.push(fullPath)
                continue
            }
            files.push(...walkFiles(fullPath))
            continue
        }
        if (entry.isFile()) {
            files.push(fullPath)
        }
    }
    return files
}

function marketplaceFileProblems(): string[] {
    return walkFiles(marketplaceRoot).flatMap((filePath) => {
        const rel = toPosix(relative(repoRoot, filePath))
        const problems: string[] = []
        if (/\.(?:zip|tgz|tar\.gz)$/i.test(rel)) {
            problems.push(`${rel}: marketplace must not commit plugin package archives; use contributor GitHub Releases.`)
        }
        if (/(^|\/)hapi\.plugin\.json$/i.test(rel)) {
            problems.push(`${rel}: marketplace must store catalog metadata, not installable plugin roots.`)
        }
        if (/(^|\/)(dist|node_modules)(\/|$)/i.test(rel)) {
            problems.push(`${rel}: marketplace must not commit built plugin output or dependencies.`)
        }
        return problems
    })
}

function pluginSourceProblems(): string[] {
    return walkFiles(pluginsRoot).flatMap((filePath) => {
        const rel = toPosix(relative(repoRoot, filePath))
        const problems: string[] = []
        if (/\.(?:zip|tgz|tar\.gz)$/i.test(rel)) {
            problems.push(`${rel}: source plugins must not commit package archives.`)
        }
        if (/(^|\/)(node_modules|\.git|dist)(\/|$)/i.test(rel)) {
            problems.push(`${rel}: source plugins must not commit dependencies, VCS internals, or built dist output.`)
        }
        return problems
    })
}

function staticImportProblems(): string[] {
    const importPattern = /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/g
    const problems: string[] = []
    for (const root of sourceRoots) {
        for (const filePath of walkFiles(root)) {
            if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
                continue
            }
            const contents = readFileSync(filePath, 'utf8')
            const matches = contents.matchAll(importPattern)
            for (const match of matches) {
                const specifier = match[1] ?? match[2] ?? ''
                if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
                    continue
                }
                const resolved = specifier.startsWith('/')
                    ? resolve(specifier)
                    : resolve(dirname(filePath), specifier)
                if (!isPathInside(marketplaceRoot, resolved)) {
                    continue
                }
                problems.push(`${toPosix(relative(repoRoot, filePath))}: runtime source must fetch marketplace metadata, not statically import ${specifier}.`)
            }
        }
    }
    return problems
}

const problems = [
    ...marketplaceFileProblems(),
    ...pluginSourceProblems(),
    ...staticImportProblems()
]

if (problems.length > 0) {
    console.error('[marketplace:check-packaging] Marketplace packaging guard failed:')
    for (const problem of problems) {
        console.error(`  - ${problem}`)
    }
    process.exit(1)
}

console.log('[marketplace:check-packaging] OK: marketplace metadata is clean and source plugins contain no packaged artifacts.')
