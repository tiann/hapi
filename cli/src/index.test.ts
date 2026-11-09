import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const entry = path.resolve(import.meta.dirname, 'index.ts')
// chmod does not restrict writes on Windows or for root.
const canMakeReadOnly = process.platform !== 'win32' && process.getuid?.() !== 0

describe.skipIf(!canMakeReadOnly)('CLI entry point with an unwritable HAPI_HOME', () => {
    let root: string
    let env: NodeJS.ProcessEnv

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'hapi-entry-'))
        const readOnly = path.join(root, 'read-only')
        mkdirSync(readOnly)
        chmodSync(readOnly, 0o555)
        env = { ...process.env, HAPI_HOME: path.join(readOnly, 'home') }
        delete env.HAPI_DISCLAIM_RESPONSIBILITY
        delete env.HAPI_LAUNCHER_PID
    })

    afterEach(() => {
        try {
            chmodSync(path.join(root, 'read-only'), 0o755)
        } catch {
            // beforeEach failed before the directory existed.
        }
        rmSync(root, { recursive: true, force: true })
    })

    it.each(['--version', '--help'])('prints %s without creating HAPI_HOME', (flag) => {
        const result = spawnSync('bun', [entry, flag], { env, encoding: 'utf8', timeout: 30_000 })

        expect(result.error).toBeUndefined()
        expect(result.stderr).not.toMatch(/EACCES/)
        expect(result.status).toBe(0)
        expect(result.stdout.length).toBeGreaterThan(0)
    }, 30_000)
})
