#!/usr/bin/env node
/** Bounded wrapper: Playwright against a real HAPI chat session (no Vite). */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const npmBin = process.env.NPM_BIN ?? 'npm'

const result = spawnSync(
    npmBin,
    ['run', 'test:mermaid-lightbox:live'],
    {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, PATH: process.env.PATH, HAPI_LIVE: '1' },
    },
)

process.exit(result.status === null ? 1 : result.status)
