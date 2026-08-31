import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..')
const cliPackagePath = join(repoRoot, 'cli', 'package.json')
const buildInfoPath = join(repoRoot, 'shared', 'src', 'buildInfo.ts')
const lockfilePath = join(repoRoot, 'bun.lock')
const VERSION_PATTERN = /^\d+\.\d+\.\d+-youngfine\.\d+$/

const version = process.argv[2]?.trim()
if (!version || !VERSION_PATTERN.test(version)) {
    console.error('Usage: bun run version:personal <X.Y.Z-youngfine.N>')
    console.error('Example: bun run version:personal 0.29.0-youngfine.1')
    process.exit(1)
}

const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf-8')) as {
    name?: string
    version?: string
}
if (cliPackage.name !== '@youngfine/hapi') {
    throw new Error(`Unexpected package name: ${cliPackage.name ?? '(missing)'}`)
}
cliPackage.version = version
writeFileSync(cliPackagePath, `${JSON.stringify(cliPackage, null, 2)}\n`)

const buildInfo = readFileSync(buildInfoPath, 'utf-8')
if (!/export const APP_VERSION = ['"][^'"]+['"]/.test(buildInfo)) {
    throw new Error('Could not find APP_VERSION')
}
writeFileSync(
    buildInfoPath,
    buildInfo.replace(
        /export const APP_VERSION = ['"][^'"]+['"]/,
        `export const APP_VERSION = '${version}'`,
    ),
)

const lockfile = readFileSync(lockfilePath, 'utf-8')
const cliWorkspacePattern = /("cli": \{\n\s+"name": "@youngfine\/hapi",\n\s+"version": ")[^"]+(")/
if (!cliWorkspacePattern.test(lockfile)) {
    throw new Error('Could not find @youngfine/hapi workspace version in bun.lock')
}
writeFileSync(
    lockfilePath,
    lockfile.replace(cliWorkspacePattern, `$1${version}$2`),
)

console.log(`Personal HAPI version set to ${version}`)
console.log('Review and commit cli/package.json, shared/src/buildInfo.ts, and bun.lock.')
