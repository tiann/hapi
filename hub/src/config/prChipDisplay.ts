import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    DEFAULT_PR_CHIP_DISPLAY,
    mergePrChipDisplayProfile,
    type PrChipDisplayProfile
} from '@hapi/protocol'

const DISPLAY_FILE = 'pr-chip-display.json'

/**
 * Load estate PR chip display overrides from `$HAPI_HOME/pr-chip-display.json`.
 * Missing / invalid file → upstream generic defaults (no Meta vocabulary).
 */
export function loadPrChipDisplayProfile(dataDir: string): PrChipDisplayProfile {
    const path = join(dataDir, DISPLAY_FILE)
    if (!existsSync(path)) {
        return DEFAULT_PR_CHIP_DISPLAY
    }
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
        return mergePrChipDisplayProfile(raw)
    } catch {
        console.warn(`[Hub] Ignoring invalid ${DISPLAY_FILE}; using generic PR chip defaults`)
        return DEFAULT_PR_CHIP_DISPLAY
    }
}

export function getPrChipDisplayFilePath(dataDir: string): string {
    return join(dataDir, DISPLAY_FILE)
}
