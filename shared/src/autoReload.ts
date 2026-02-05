/**
 * Auto-reload mechanism for detecting binary updates
 * Monitors binary modification time and triggers callback when changed
 */

import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface AutoReloadOptions {
    /**
     * Function to call when a reload is detected
     * Should initiate graceful shutdown
     */
    onReloadDetected: () => void | Promise<void>

    /**
     * Check interval in milliseconds
     * @default 60000 (60 seconds)
     */
    checkIntervalMs?: number

    /**
     * Optional: Function to get current binary mtime
     * Useful for testing or custom binary detection
     */
    getBinaryMtime?: () => number | undefined
}

export interface AutoReloadHandle {
    /**
     * Stop monitoring for changes
     */
    stop: () => void

    /**
     * Get the mtime the process started with
     */
    getStartMtime: () => number | undefined

    /**
     * Manually trigger a check (useful for signals like SIGUSR1)
     */
    checkNow: () => boolean
}

/**
 * Detect if running as a Bun compiled executable
 */
function isBunCompiled(): boolean {
    return typeof Bun !== 'undefined' && Bun.main === process.argv[1]
}

/**
 * Get project root by walking up from current file
 */
function getProjectPath(): string {
    const currentFile = import.meta.url
    const parts = currentFile.split('/')
    const sharedIndex = parts.lastIndexOf('shared')
    if (sharedIndex > 0) {
        return parts.slice(0, sharedIndex).join('/').replace('file://', '')
    }
    return process.cwd()
}

/**
 * Get the mtime of the currently installed binary.
 * Works in both compiled and development mode.
 */
function getInstalledBinaryMtime(): number | undefined {
    if (isBunCompiled()) {
        try {
            return statSync(process.execPath).mtimeMs
        } catch {
            return undefined
        }
    }

    // Development mode: check package.json mtime as a proxy
    const packageJsonPath = join(getProjectPath(), 'package.json')
    if (!existsSync(packageJsonPath)) {
        return undefined
    }

    try {
        return statSync(packageJsonPath).mtimeMs
    } catch {
        return undefined
    }
}

/**
 * Start monitoring for binary updates and trigger reload when detected.
 * Returns a handle to control the monitoring.
 */
export function startAutoReload(options: AutoReloadOptions): AutoReloadHandle {
    const {
        onReloadDetected,
        checkIntervalMs = Number.parseInt(process.env.HAPI_AUTO_RELOAD_INTERVAL || '60000'),
        getBinaryMtime = getInstalledBinaryMtime,
    } = options

    const startedWithMtime = getBinaryMtime()
    let intervalHandle: Timer | null = null
    let isChecking = false

    /**
     * Check if binary has changed. Returns true if reload is needed.
     */
    const checkForUpdate = (): boolean => {
        if (isChecking) {
            return false
        }

        isChecking = true
        try {
            const currentMtime = getBinaryMtime()

            if (
                typeof currentMtime === 'number' &&
                typeof startedWithMtime === 'number' &&
                currentMtime !== startedWithMtime
            ) {
                return true
            }

            return false
        } finally {
            isChecking = false
        }
    }

    /**
     * Interval callback
     */
    const onInterval = async () => {
        if (checkForUpdate()) {
            // Stop checking before triggering reload
            if (intervalHandle) {
                clearInterval(intervalHandle)
                intervalHandle = null
            }

            // Trigger reload callback
            await Promise.resolve(onReloadDetected())
        }
    }

    // Start interval
    intervalHandle = setInterval(onInterval, checkIntervalMs)

    return {
        stop() {
            if (intervalHandle) {
                clearInterval(intervalHandle)
                intervalHandle = null
            }
        },

        getStartMtime() {
            return startedWithMtime
        },

        checkNow() {
            return checkForUpdate()
        },
    }
}
