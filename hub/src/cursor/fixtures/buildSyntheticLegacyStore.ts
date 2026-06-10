/**
 * Build a synthetic legacy stream-json store.db for tests.
 *
 * The real cursor-agent legacy store has the same schema as the ACP one:
 *
 *   CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
 *   CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
 *
 * The migrator only ever reads the meta record (for lastUsedModel + name).
 * Tests that drive the migrator against a synthetic store can use this
 * builder to create a sufficiently realistic file without paying token
 * cost or depending on a real cursor-agent install.
 *
 * NOT a public hub export - used only from hub/src/cursor/*.test.ts.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface BuildSyntheticStoreOpts {
    /** Absolute file path to write store.db to. Parent dirs created automatically. */
    path: string
    /** Free-form session name shown by the IDE; mirrors meta.name. */
    name?: string
    /** lastUsedModel hint (legacy stream-json or ACP wireid; both valid). */
    lastUsedModel?: string
    /** agentId; arbitrary string (cursor-agent doesn't validate it). */
    agentId?: string
    /** ISO timestamp; defaults to now. */
    createdAt?: string
    /**
     * Whether to store meta value as hex-encoded UTF-8 JSON (older cursor-agent
     * versions) or as raw JSON text (newer versions). Defaults to hex which is
     * what the on-disk fodder sessions in the spike were stored as.
     */
    metaEncoding?: 'hex' | 'json'
}

export function buildSyntheticLegacyStore(opts: BuildSyntheticStoreOpts): void {
    const { path } = opts
    mkdirSync(dirname(path), { recursive: true })
    // Pre-touch the file so bun:sqlite definitely creates a fresh DB instead
    // of opening anything pre-existing.
    writeFileSync(path, '')
    const db = new Database(path, { create: true, readwrite: true })
    try {
        db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB)')
        db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
        const metaPayload: Record<string, unknown> = {
            agentId: opts.agentId ?? 'synthetic-agent',
            latestRootBlobId: 'synthetic-root',
            name: opts.name ?? 'synthetic legacy chat',
            mode: 'agent',
            createdAt: opts.createdAt ?? new Date().toISOString()
        }
        if (opts.lastUsedModel) {
            metaPayload.lastUsedModel = opts.lastUsedModel
        }
        const json = JSON.stringify(metaPayload)
        const encoded = (opts.metaEncoding ?? 'hex') === 'hex'
            ? Buffer.from(json, 'utf8').toString('hex')
            : json
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('record', encoded)
    } finally {
        db.close()
    }
}
