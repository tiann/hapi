import type { Database } from 'bun:sqlite'
import {
    machineRegistrationNeedsRefresh,
    mergeMachineRegistrationMetadata,
} from '@hapi/protocol/machineRegistration'

import type { StoredMachine, VersionedUpdateResult } from './types'
import { safeJsonParse } from './json'
import { updateVersionedField } from './versionedUpdates'

type DbMachineRow = {
    id: string
    namespace: string
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    runner_state: string | null
    runner_state_version: number
    active: number
    active_at: number | null
    seq: number
}

function toStoredMachine(row: DbMachineRow): StoredMachine {
    return {
        id: row.id,
        namespace: row.namespace,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        runnerState: safeJsonParse(row.runner_state),
        runnerStateVersion: row.runner_state_version,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

export function getOrCreateMachine(
    db: Database,
    id: string,
    metadata: unknown,
    runnerState: unknown,
    namespace: string
): StoredMachine {
    const existing = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
    if (existing) {
        const stored = toStoredMachine(existing)
        if (stored.namespace !== namespace) {
            throw new Error('Machine namespace mismatch')
        }
        // Re-registering runners used to keep stale hub metadata forever
        // (version/capabilities from the first connect). Refresh identity when
        // the client sends newer registration fields.
        if (machineRegistrationNeedsRefresh(stored.metadata, metadata)) {
            const merged = mergeMachineRegistrationMetadata(stored.metadata, metadata)
            const result = updateMachineMetadata(
                db,
                id,
                merged,
                stored.metadataVersion,
                namespace,
            )
            if (result.result === 'success') {
                const refreshed = getMachine(db, id)
                if (refreshed) {
                    return refreshed
                }
            }
            // Version conflict or race: fall through to current row; connect
            // path can still push identity via machine-update-metadata.
        }
        return getMachine(db, id) ?? stored
    }

    const now = Date.now()
    const metadataJson = JSON.stringify(metadata)
    const runnerStateJson = runnerState === null || runnerState === undefined ? null : JSON.stringify(runnerState)

    db.prepare(`
        INSERT INTO machines (
            id, namespace, created_at, updated_at,
            metadata, metadata_version,
            runner_state, runner_state_version,
            active, active_at, seq
        ) VALUES (
            @id, @namespace, @created_at, @updated_at,
            @metadata, 1,
            @runner_state, 1,
            0, NULL, 0
        )
    `).run({
        id,
        namespace,
        created_at: now,
        updated_at: now,
        metadata: metadataJson,
        runner_state: runnerStateJson
    })

    const row = getMachine(db, id)
    if (!row) {
        throw new Error('Failed to create machine')
    }
    return row
}

export function updateMachineMetadata(
    db: Database,
    id: string,
    metadata: unknown,
    expectedVersion: number,
    namespace: string
): VersionedUpdateResult<unknown | null> {
    const now = Date.now()

    return updateVersionedField({
        db,
        table: 'machines',
        id,
        namespace,
        field: 'metadata',
        versionField: 'metadata_version',
        expectedVersion,
        value: metadata,
        encode: (value) => {
            const json = JSON.stringify(value)
            return json === undefined ? null : json
        },
        decode: safeJsonParse,
        setClauses: ['updated_at = @updated_at', 'seq = seq + 1'],
        params: { updated_at: now }
    })
}

export function updateMachineRunnerState(
    db: Database,
    id: string,
    runnerState: unknown,
    expectedVersion: number,
    namespace: string
): VersionedUpdateResult<unknown | null> {
    const now = Date.now()
    const normalized = runnerState ?? null

    return updateVersionedField({
        db,
        table: 'machines',
        id,
        namespace,
        field: 'runner_state',
        versionField: 'runner_state_version',
        expectedVersion,
        value: normalized,
        encode: (value) => (value === null ? null : JSON.stringify(value)),
        decode: safeJsonParse,
        setClauses: [
            'updated_at = @updated_at',
            'active = 1',
            'active_at = @active_at',
            'seq = seq + 1'
        ],
        params: { updated_at: now, active_at: now }
    })
}

export function getMachine(db: Database, id: string): StoredMachine | null {
    const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
    return row ? toStoredMachine(row) : null
}

export function getMachineByNamespace(db: Database, id: string, namespace: string): StoredMachine | null {
    const row = db.prepare(
        'SELECT * FROM machines WHERE id = ? AND namespace = ?'
    ).get(id, namespace) as DbMachineRow | undefined
    return row ? toStoredMachine(row) : null
}

export function getMachines(db: Database): StoredMachine[] {
    const rows = db.prepare('SELECT * FROM machines ORDER BY updated_at DESC').all() as DbMachineRow[]
    return rows.map(toStoredMachine)
}

export function getMachinesByNamespace(db: Database, namespace: string): StoredMachine[] {
    const rows = db.prepare(
        'SELECT * FROM machines WHERE namespace = ? ORDER BY updated_at DESC'
    ).all(namespace) as DbMachineRow[]
    return rows.map(toStoredMachine)
}
