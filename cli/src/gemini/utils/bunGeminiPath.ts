/**
 * Utilities for detecting and using Bun-optimized Gemini CLI
 * Provides performance optimization by using Bun runtime when available
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { logger } from '@/ui/logger';

/**
 * Check if Bun-optimized Gemini CLI is available
 *
 * This function detects if:
 * 1. Bun runtime is installed and available
 * 2. Gemini CLI is installed via Bun (not npm)
 *
 * Returns the path to Bun-optimized Gemini CLI if both conditions are met,
 * null otherwise (fallback to standard Node.js version)
 *
 * @returns Path to Bun-optimized Gemini CLI or null
 */
export function getBunGeminiPath(): string | null {
    try {
        // Path where Bun installs global packages
        // ~/.bun/install/global/node_modules/@google/gemini-cli/dist/index.js
        const bunGeminiPath = join(
            homedir(),
            '.bun',
            'install',
            'global',
            'node_modules',
            '@google',
            'gemini-cli',
            'dist',
            'index.js'
        );

        // Check if Bun-optimized Gemini CLI package exists
        if (!existsSync(bunGeminiPath)) {
            return null;
        }

        // Verify that Bun command itself is available on the system
        const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });

        if (bunCheck.error || bunCheck.status !== 0) {
            logger.debug('[Gemini] Bun command not available, falling back to standard Gemini CLI');
            return null;
        }

        return bunGeminiPath;
    } catch (error) {
        // If any error occurs during check, safely return null
        // This ensures compatibility even in error scenarios
        logger.debug('[Gemini] Error checking Bun availability:', error);
        return null;
    }
}
