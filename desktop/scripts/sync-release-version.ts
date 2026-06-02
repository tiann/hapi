import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(__dirname, '..', 'package.json')
const rawVersion = process.env.HAPI_DESKTOP_VERSION || process.env.GITHUB_REF_NAME

if (!rawVersion) {
    throw new Error('HAPI_DESKTOP_VERSION or GITHUB_REF_NAME is required to sync desktop release version.')
}

const version = rawVersion.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid desktop release version: ${rawVersion}`)
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
packageJson.version = version
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 4)}\n`, 'utf8')
console.log(`Synced desktop package version to ${version}`)
