import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configurationUrl = new URL('../configuration.ts', import.meta.url).href
const jwtSecretUrl = new URL('./jwtSecret.ts', import.meta.url).href
const jwtScript = [
    'import { createConfiguration } from ' + JSON.stringify(configurationUrl),
    'import { getOrCreateJwtSecret } from ' + JSON.stringify(jwtSecretUrl),
    'await createConfiguration()',
    'const secret = await getOrCreateJwtSecret()',
    "console.log('JWT_RESULT=' + Buffer.from(secret).toString('base64'))",
].join('\n')

function loadJwtSecretInChild(home: string) {
    return spawnSync(process.execPath, ['-e', jwtScript], {
        env: {
            ...process.env,
            HAPI_HOME: home,
            DB_PATH: join(home, 'hapi.db'),
            CLI_API_TOKEN: 'jwt-secret-test-independent-token-1234567890',
            HAPI_NAMESPACE_TOKENS_JSON: '{}',
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_NOTIFICATION: 'false',
        },
        encoding: 'utf8',
    })
}

function readJwtResult(stdout: string): string {
    const match = stdout.match(/^JWT_RESULT=(.+)$/m)
    if (!match) throw new Error(`JWT child did not emit a result: ${stdout}`)
    return match[1]
}

describe('JWT secret private-file integration', () => {
    it('creates and reuses one private 32-byte signing key across processes', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-jwt-secret-integration-'))
        try {
            const home = join(root, 'home')
            await mkdir(home, { mode: 0o777 })
            await chmod(home, 0o777)

            const first = loadJwtSecretInChild(home)
            const second = loadJwtSecretInChild(home)

            expect(first.status, first.stderr).toBe(0)
            expect(second.status, second.stderr).toBe(0)
            const firstSecret = readJwtResult(first.stdout)
            const secondSecret = readJwtResult(second.stdout)
            expect(secondSecret).toBe(firstSecret)
            expect(Buffer.from(firstSecret, 'base64')).toHaveLength(32)
            if (process.platform !== 'win32') {
                expect((await stat(home)).mode & 0o777).toBe(0o700)
                expect((await stat(join(home, 'jwt-secret.json'))).mode & 0o777).toBe(0o600)
            }
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it.skipIf(process.platform === 'win32')(
        'rejects a preplaced known-key symlink through the actual JWT loader',
        async () => {
            const root = mkdtempSync(join(tmpdir(), 'hapi-jwt-secret-known-key-'))
            try {
                const home = join(root, 'home')
                const knownKeyFile = join(root, 'attacker-known-key.json')
                const knownKeyPayload = JSON.stringify({
                    secretBase64: Buffer.alloc(32, 7).toString('base64'),
                }, null, 4)
                await mkdir(home)
                await writeFile(knownKeyFile, knownKeyPayload)
                await symlink(knownKeyFile, join(home, 'jwt-secret.json'))

                const result = loadJwtSecretInChild(home)

                expect(result.status).not.toBe(0)
                expect(result.stderr).toContain('Unsafe private file')
                expect(result.stderr).toContain('symbolic links are not allowed')
                expect(await readFile(knownKeyFile, 'utf8')).toBe(knownKeyPayload)
            } finally {
                rmSync(root, { recursive: true, force: true })
            }
        },
    )
})
