import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const productName = 'HAPI Desktop'
const companyName = 'HAPI contributors'
const desktopRoot = resolve(import.meta.dir, '..')
const releaseDir = join(desktopRoot, 'release')
const iconPath = join(desktopRoot, 'assets', 'icon.ico')

const rceditPath = findRcedit()
const exePaths = findBuiltExecutables()

if (exePaths.length === 0) {
    console.warn('[patch-win-metadata] No Windows executables found, skipped.')
    process.exit(0)
}

for (const exePath of exePaths) {
    const result = spawnSync(rceditPath, [
        exePath,
        '--set-version-string',
        'FileDescription',
        productName,
        '--set-version-string',
        'ProductName',
        productName,
        '--set-version-string',
        'InternalName',
        productName,
        '--set-version-string',
        'OriginalFilename',
        `${productName}.exe`,
        '--set-version-string',
        'CompanyName',
        companyName,
        '--set-icon',
        iconPath
    ], {
        encoding: 'utf8',
        stdio: 'pipe'
    })

    if (result.status !== 0) {
        console.error(result.stdout)
        console.error(result.stderr)
        throw new Error(`[patch-win-metadata] Failed to patch ${exePath}`)
    }

    console.log(`[patch-win-metadata] Patched ${exePath}`)
}

function findRcedit(): string {
    const candidates = [
        join(desktopRoot, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
        join(desktopRoot, '..', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
        join(desktopRoot, '..', 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
    ]

    const rcedit = candidates.find((candidate) => existsSync(candidate))
    if (!rcedit) {
        throw new Error('[patch-win-metadata] rcedit.exe not found. Install rcedit or electron-winstaller.')
    }
    return rcedit
}

function findBuiltExecutables(): string[] {
    if (!existsSync(releaseDir)) {
        return []
    }

    const unpackedExe = join(releaseDir, 'win-unpacked', `${productName}.exe`)
    return existsSync(unpackedExe) ? [unpackedExe] : []
}
