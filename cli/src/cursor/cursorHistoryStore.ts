import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX = /^(?:[a-f0-9]{2})+$/
const FORK_FIELDS = ['mode', 'isRunEverything', 'approvalMode', 'lastUsedModel', 'lastDebugServerPort', 'currentPlanUri'] as const

function acpSessionsDir(home: string): string {
    // Mirrors cursor-config's ACP root precedence. Relative overrides would
    // depend on the agent child process's working directory.
    const override = process.env.CURSOR_CONFIG_DIR
    const xdg = process.env.XDG_CONFIG_HOME
    const config = override?.trim() ? override : xdg?.trim() ? join(xdg, 'cursor') : join(home, '.cursor')
    if (!isAbsolute(config)) throw new Error('Unsupported relative Cursor configuration directory')
    return join(config, 'acp-sessions')
}

/** Read the committed WAL snapshot. Never checkpoint or open the source for writing. */
function withSnapshot<T>(home: string, cwd: string, sessionId: string, read: (db: Database, meta: Record<string, unknown>, root: string) => T): T {
    if (!UUID.test(sessionId) || !isAbsolute(cwd)) throw new Error('Invalid Cursor session or workspace')
    const dir = join(acpSessionsDir(home), sessionId)
    const dbPath = join(dir, 'store.db')
    const sidecarPath = join(dir, 'meta.json')
    if (!lstatSync(dir).isDirectory() || !lstatSync(sidecarPath).isFile() || !lstatSync(dbPath).isFile()) {
        throw new Error('Expected a local Cursor ACP store')
    }
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    if (sidecar?.schemaVersion !== 1 || sidecar.cwd !== cwd) throw new Error('Cursor workspace or sidecar version mismatch')

    const db = new Database(dbPath, { readonly: true })
    try {
        return db.transaction(() => {
            const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
            if (version?.user_version !== 1) throw new Error('Unsupported Cursor store version')
            const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = '0'").get()
            if (typeof row?.value !== 'string' || !HEX.test(row.value)) throw new Error('Unsupported Cursor metadata')
            const meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'))
            if (meta?.agentId !== sessionId || typeof meta.latestRootBlobId !== 'string') {
                throw new Error('Cursor store identity or root mismatch')
            }
            return read(db, meta, meta.latestRootBlobId)
        })()
    } finally {
        db.close()
    }
}

function readBlob(db: Database, id: string): Buffer {
    // Cursor also has a fixed-root store mode. A mutable slot is unsafe as a
    // turn checkpoint. Accept only its ordinary content-addressed root.
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unsupported Cursor blob ID')
    const row = db.query<{ data: Uint8Array }, [string]>('SELECT data FROM blobs WHERE id = ?').get(id)
    if (!(row?.data instanceof Uint8Array) || createHash('sha256').update(row.data).digest('hex') !== id) {
        throw new Error('Missing or mutable Cursor conversation blob')
    }
    return Buffer.from(row.data)
}

// Read only the protobuf fields used by Cursor's conversation-only rewind.
// Unsupported wire forms and incomplete records refuse the message boundary.
function fields(bytes: Buffer, wanted: number, expectedWire = 2): Buffer[] {
    let pos = 0
    function varint(): number {
        let value = 0
        for (let i = 0; i < 10 && pos < bytes.length; i++) {
            const b = bytes[pos++]
            value += (b & 127) * 2 ** (7 * i)
            if (b < 128) return value
        }
        throw new Error('Invalid Cursor protobuf varint')
    }
    const result: Buffer[] = []
    while (pos < bytes.length) {
        const tag = varint()
        if (tag < 8 || tag > 0xffffffff) throw new Error('Invalid Cursor protobuf tag')
        const wire = tag & 7
        const match = tag >>> 3 === wanted
        if (match && wire !== expectedWire) throw new Error('Unexpected Cursor protobuf field type')
        const start = pos
        if (wire === 0) varint()
        else if (wire === 1) pos += 8
        else if (wire === 5) pos += 4
        else if (wire === 2) {
            const length = varint()
            if (length > bytes.length - pos) throw new Error('Truncated Cursor protobuf field')
            if (match) result.push(bytes.subarray(pos, pos + length))
            pos += length
        } else throw new Error('Unsupported Cursor protobuf wire type')
        if (pos > bytes.length) throw new Error('Truncated Cursor protobuf field')
        if (wire !== 2 && match) result.push(bytes.subarray(start, pos))
    }
    return result
}

function onlyField(bytes: Buffer, field: number): Buffer {
    const values = fields(bytes, field)
    if (values.length !== 1) throw new Error('Expected a unique native Cursor field')
    return values[0]
}

function readTurns(db: Database, root: string): Buffer[] {
    if (root === '') return [] // Cursor's initial, unmaterialized root pointer.
    const turns = fields(readBlob(db, root), 8)
    if (turns.some(id => id.length !== 32)) throw new Error('Unsupported Cursor turn reference')
    return turns
}

function assertTurnPrefix(prefix: Buffer[], turns: Buffer[]): void {
    if (prefix.length >= turns.length || prefix.some((id, i) => !id.equals(turns[i]))) {
        throw new Error('Cursor conversation no longer contains the captured boundary')
    }
}

function userAt(db: Database, turnId: Buffer): Buffer {
    const turn = readBlob(db, turnId.toString('hex'))
    if (fields(turn, 2).length) throw new Error('Shell turns are not Cursor rewind boundaries')
    const agentTurn = onlyField(turn, 1)
    return readBlob(db, onlyField(agentTurn, 1).toString('hex'))
}

function userAnchor(user: Buffer): string {
    if (fields(user, 5, 0).some(flag => flag.length !== 1 || flag[0] !== 0) || fields(user, 14).length) {
        throw new Error('Simulated and execute-plan turns are not Cursor rewind boundaries')
    }
    const id = onlyField(user, 10)
    if (id.length !== 32) throw new Error('Missing native Cursor conversation anchor')
    return id.toString('hex')
}

export function confirmCursorHistoryTurn(home: string, cwd: string, sessionId: string, before: string, promptText: string): string {
    return withSnapshot(home, cwd, sessionId, (db, _meta, current) => {
        const turns = readTurns(db, current)
        const previous = readTurns(db, before)
        assertTurnPrefix(previous, turns)
        if (turns.length !== previous.length + 1) throw new Error('Expected one new native Cursor turn')
        const user = userAt(db, turns[previous.length])
        const texts = fields(user, 1)
        if (texts.length > 1) throw new Error('Ambiguous Cursor user prompt')
        const text = texts[0]
        const actualText = text?.length ? text : readBlob(db, onlyField(user, 18).toString('hex'))
        if (!actualText.equals(Buffer.from(promptText))) throw new Error('Cursor native user prompt differs')
        const anchor = userAnchor(user)
        const anchored = readTurns(db, anchor)
        assertTurnPrefix(anchored, turns)
        if (anchored.length !== previous.length) throw new Error('Cursor native anchor differs from the captured turn')
        return anchor
    })
}

export function readCursorHistoryRoot(home: string, cwd: string, sessionId: string): string {
    return withSnapshot(home, cwd, sessionId, (db, _meta, root) => {
        readTurns(db, root)
        return root
    })
}

/** Fork into a fresh ACP drawer using Cursor's blob and metadata format. */
export function forkCursorHistoryStore(home: string, cwd: string, sessionId: string, observedRoot?: string): string {
    return withSnapshot(home, cwd, sessionId, (source, meta, currentRoot) => {
        const root = observedRoot ?? currentRoot
        const turns = readTurns(source, currentRoot)
        if (observedRoot !== undefined) {
            const prefix = readTurns(source, observedRoot)
            assertTurnPrefix(prefix, turns)
            if (userAnchor(userAt(source, turns[prefix.length])) !== observedRoot) {
                throw new Error('Cursor conversation no longer references the captured anchor')
            }
        }
        const sessions = acpSessionsDir(home)
        const id = randomUUID()
        const staging = mkdtempSync(join(sessions, '.hapi-fork-'))
        try {
            const dest = new Database(join(staging, 'store.db'), { create: true })
            try {
                dest.transaction(() => {
                    dest.exec('PRAGMA user_version = 1; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
                    const insert = dest.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
                    for (const blob of source.query<{ id: string, data: Uint8Array }, []>('SELECT id, data FROM blobs').iterate()) {
                        insert.run(blob.id, blob.data)
                    }
                    const forkMeta: Record<string, unknown> = {
                        agentId: id,
                        name: `${typeof meta.name === 'string' && meta.name.trim() || 'New Agent'} (forked)`,
                        createdAt: Date.now(),
                        latestRootBlobId: root,
                        blobEncryptionKey: randomBytes(32).toString('hex')
                    }
                    for (const key of FORK_FIELDS) forkMeta[key] = meta[key]
                    const encoded = Buffer.from(JSON.stringify(forkMeta)).toString('hex')
                    dest.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(encoded)
                    writeFileSync(join(staging, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd, title: forkMeta.name }), { mode: 0o600 })
                })()
            } finally {
                dest.close()
            }
            renameSync(staging, join(sessions, id))
            return id
        } catch (error) {
            rmSync(staging, { recursive: true, force: true })
            throw error
        }
    })
}
