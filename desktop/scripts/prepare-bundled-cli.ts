import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(__dirname, '..')
const repoRoot = resolve(desktopRoot, '..')

type Target = {
    packageName: string
    resourceDir: string
    binaryName: string
}

const target = resolveTarget()
const source = await findBinary(target)
const destinationDir = join(desktopRoot, 'resources', 'hapi-cli', target.resourceDir)
const destination = join(destinationDir, target.binaryName)

await mkdir(destinationDir, { recursive: true })
await copyFile(source, destination)
console.log(`[desktop] bundled CLI copied: ${source} -> ${destination}`)

function resolveTarget(): Target {
    const targetPlatform = process.env.HAPI_DESKTOP_CLI_PLATFORM ?? process.platform

    if (targetPlatform === 'win32') {
        return {
            packageName: '@twsxtd/hapi-win32-x64',
            resourceDir: 'win',
            binaryName: 'hapi.exe'
        }
    }

    if (targetPlatform === 'darwin') {
        const arch = process.env.HAPI_DESKTOP_CLI_ARCH === 'x64' || process.env.HAPI_DESKTOP_CLI_ARCH === 'arm64'
            ? process.env.HAPI_DESKTOP_CLI_ARCH
            : process.arch === 'arm64' ? 'arm64' : 'x64'
        return {
            packageName: `@twsxtd/hapi-darwin-${arch}`,
            resourceDir: 'mac',
            binaryName: 'hapi'
        }
    }

    throw new Error(`Desktop packaging only supports win32 and darwin, got ${targetPlatform}`)
}

async function findBinary(target: Target): Promise<string> {
    const candidates = [
        join(repoRoot, 'node_modules', target.packageName, 'bin', target.binaryName),
        join(repoRoot, 'cli', 'node_modules', target.packageName, 'bin', target.binaryName)
    ]

    for (const candidate of candidates) {
        if (await isFile(candidate)) {
            return candidate
        }
    }

    throw new Error(`Missing bundled CLI binary for ${target.packageName}. Run bun install on that platform or build the platform package first.`)
}

async function isFile(path: string): Promise<boolean> {
    try {
        const stats = await stat(path)
        return stats.isFile()
    } catch {
        return false
    }
}
