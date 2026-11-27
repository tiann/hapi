import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// CLI unit tests run under Node. Exercise the real bun:sqlite driver in a
// disposable home, with committed history that is still in the source WAL.
describe('Cursor native conversation store', () => {
    it('forks committed roots, isolates identities and rejects incompatible stores', () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-cursor-history-test-'))
        try {
            const result = spawnSync('bun', ['-e', `
                import assert from 'node:assert/strict'
                import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
                import { join } from 'node:path'
                import { createHash, randomUUID } from 'node:crypto'
                import { Database } from 'bun:sqlite'
                import { confirmCursorHistoryTurn, readCursorHistoryRoot, forkCursorHistoryStore } from './cursorHistoryStore'

                const home = process.env.TEST_CURSOR_HOME
                const cwd = join(home, 'workspace')
                mkdirSync(cwd)
                const session = randomUUID()
                const sessions = join(home, '.cursor', 'acp-sessions')
                const dir = join(sessions, session)
                mkdirSync(dir, { recursive: true })
                writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))
                const db = new Database(join(dir, 'store.db'))
                db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
                const encode = obj => Buffer.from(JSON.stringify(obj)).toString('hex')
                const meta = { agentId: session, name: 'Source', subagentInfo: {}, blobEncryptionKey: 'a'.repeat(64), mode: 'plan', lastUsedModel: 'synthetic', latestRootBlobId: '' }
                const save = () => db.query("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(encode(meta))
                const rows = db => db.query('SELECT id, hex(data) as bytes FROM blobs ORDER BY id').all()
                save()
                assert.equal(readCursorHistoryRoot(home, cwd, session), '')
                const turns = []
                function blob(data) {
                    const id = createHash('sha256').update(data).digest()
                    db.query('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(id.toString('hex'), data)
                    return id
                }
                function field(number, bytes) {
                    assert(number < 16 && bytes.length < 128)
                    return Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes])
                }
                const empty = blob(Buffer.alloc(0)).toString('hex')
                function advance(text) {
                    const previous = meta.latestRootBlobId
                    const anchor = previous || empty
                    const user = blob(Buffer.concat([field(1, Buffer.from(text)), field(10, Buffer.from(anchor, 'hex'))]))
                    const turn = blob(field(1, field(1, user)))
                    turns.push(field(8, turn))
                    meta.latestRootBlobId = blob(Buffer.concat(turns)).toString('hex')
                    save()
                    assert.equal(confirmCursorHistoryTurn(home, cwd, session, previous, text), anchor)
                    return readCursorHistoryRoot(home, cwd, session)
                }
                const before = advance('first committed turn')
                const after = advance('second committed turn')
                assert.throws(() => confirmCursorHistoryTurn(home, cwd, session, before, 'different prompt'), /prompt differs/)
                assert.throws(() => confirmCursorHistoryTurn(home, cwd, session, '', 'second committed turn'), /one new/)
                for (const root of [undefined, before, empty]) {
                    const id = forkCursorHistoryStore(home, cwd, session, root)
                    assert.notEqual(id, session)
                    assert.equal(readCursorHistoryRoot(home, cwd, id), root ?? after)
                    const fork = new Database(join(sessions, id, 'store.db'), { readonly: true })
                    const copied = JSON.parse(Buffer.from(fork.query("SELECT value FROM meta WHERE key='0'").get().value, 'hex'))
                    assert.equal(copied.agentId, id)
                    assert.equal(copied.name, 'Source (forked)')
                    assert.equal(copied.mode, 'plan')
                    assert.equal(copied.lastUsedModel, 'synthetic')
                    assert.equal(copied.subagentInfo, undefined)
                    assert.match(copied.blobEncryptionKey, /^[a-f0-9]{64}$/)
                    assert.notEqual(copied.blobEncryptionKey, meta.blobEncryptionKey)
                    assert.deepEqual(rows(fork), rows(db))
                    fork.close()
                }
                assert.equal(db.query("SELECT value FROM meta WHERE key='0'").get().value, encode(meta))
                const initialDirs = readdirSync(sessions)
                assert.throws(() => forkCursorHistoryStore(home, cwd, session, 'b'.repeat(64)), /Missing or mutable/)
                assert.throws(() => forkCursorHistoryStore(home, cwd + '-wrong', session), /workspace/)
                assert.throws(() => forkCursorHistoryStore(home, cwd, '../other'), /Invalid/)
                db.query('UPDATE blobs SET data = ? WHERE id = ?').run(Buffer.from('changed'), before)
                assert.throws(() => forkCursorHistoryStore(home, cwd, session, before), /Missing or mutable/)
                db.exec('PRAGMA user_version=2')
                assert.throws(() => forkCursorHistoryStore(home, cwd, session), /version/)
                assert.deepEqual(readdirSync(sessions), initialDirs)
                db.close()
            `], {
                cwd: import.meta.dirname,
                env: { ...process.env, TEST_CURSOR_HOME: home, CURSOR_CONFIG_DIR: join(home, '.cursor'), XDG_CONFIG_HOME: join(home, 'xdg') },
                encoding: 'utf8'
            })
            expect(result.status, result.stderr).toBe(0)
        } finally {
            rmSync(home, { recursive: true, force: true })
        }
    })
})
