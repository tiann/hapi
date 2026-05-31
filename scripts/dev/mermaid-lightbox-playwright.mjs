#!/usr/bin/env node
/**
 * Bounded wrapper for mermaid lightbox Playwright (web/e2e).
 * Vite lifecycle is owned by web/playwright.config.ts webServer — not this process.
 *
 * Usage (from repo root):
 *   npm run test:mermaid-lightbox:playwright
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web')
const npmBin = process.env.NPM_BIN ?? 'npm'

const result = spawnSync(
    npmBin,
    ['run', 'test:mermaid-lightbox:e2e'],
    {
        cwd: WEB_DIR,
        stdio: 'inherit',
        env: { ...process.env, PATH: process.env.PATH },
    },
)

process.exit(result.status === null ? 1 : result.status)
