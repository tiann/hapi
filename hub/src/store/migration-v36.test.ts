import { expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '.'

it('adds passkey_credentials when upgrading a v35 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-passkey-v36-migration-'))
    try {
        const path = join(dir, 'hub.db')
        new Store(path).close()
        const legacy = new Database(path)
        legacy.exec('DROP TABLE passkey_credentials; PRAGMA user_version = 35;')
        legacy.close()
        const migrated = new Store(path)
        try {
            const internalDb = (migrated as unknown as { db: Database }).db
            expect((internalDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(38)
            migrated.passkeys.add({
                id: 'cred', namespace: 'default', rpId: 'localhost', publicKey: new Uint8Array([1, 2, 3]),
                counter: 0, transports: ['internal'], tokenFingerprint: 'fp', name: null, createdAt: 1
            })
            expect(migrated.passkeys.get('cred')).toMatchObject({ rpId: 'localhost', transports: ['internal'] })
            expect(Array.from(migrated.passkeys.get('cred')!.publicKey)).toEqual([1, 2, 3])
        } finally { migrated.close() }
    } finally { Bun.gc(true); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
