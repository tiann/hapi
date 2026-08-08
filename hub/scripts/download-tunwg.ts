/**
 * Download pinned tunwg binaries for all platforms.
 *
 * Thin CLI wrapper around hub/src/upgrade/tunwgPin.ts.
 * Output directory: shared/tools/tunwg/
 */

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    TUNWG_PINS,
    TUNWG_RELEASE_TAG,
    assertTunwgDigest,
    ensurePinnedTunwgBinary,
} from '../src/upgrade/tunwgPin'

const isWindows = process.platform === 'win32'

async function main(): Promise<void> {
    let scriptDir: string
    if (isWindows) {
        const __filename = fileURLToPath(import.meta.url)
        scriptDir = dirname(__filename)
    } else {
        scriptDir = dirname(new URL(import.meta.url).pathname)
    }
    const toolsDir = join(scriptDir, '..', '..', 'shared', 'tools', 'tunwg')

    console.log(`Downloading pinned tunwg binaries (${TUNWG_RELEASE_TAG})...\n`)

    for (const platformKey of Object.keys(TUNWG_PINS) as Array<keyof typeof TUNWG_PINS>) {
        const pin = TUNWG_PINS[platformKey]
        const destPath = join(toolsDir, pin.filename)
        if (existsSync(destPath)) {
            try {
                assertTunwgDigest(destPath, pin.sha256)
                console.log(`Skipping ${pin.filename} (already exists, digest ok)`)
                continue
            } catch (error) {
                console.warn(`Replacing ${pin.filename}: ${error instanceof Error ? error.message : error}`)
            }
        }
        await ensurePinnedTunwgBinary({ toolsDir, platformKey })
        console.log(`  -> ${pin.filename} (sha256 ok)`)
    }

    console.log('\nDone!')
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error)
        process.exit(1)
    })
}
