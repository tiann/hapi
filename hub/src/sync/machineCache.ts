import type { Machine, MachinePatch } from '@hapi/protocol/types'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { MachineHealthSchema, MachineMetadataSchema, RunnerStateSchema } from '@hapi/protocol/schemas'
import type { Store } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'

type MachineAlivePayload = {
    machineId: string
    time: number
    health?: unknown
}

const METADATA_RETRY_ATTEMPTS = 5

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMachineHealth(value: unknown): Machine['health'] {
    const parsed = MachineHealthSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

function healthDisplayChanged(
    before: Machine['health'] | undefined,
    after: Machine['health'] | null | undefined
): boolean {
    if (!before && !after) {
        return false
    }
    if (!before || !after) {
        return true
    }

    return before.load1m !== after.load1m
        || before.cpuPercent !== after.cpuPercent
        || before.memoryPercent !== after.memoryPercent
        || before.cpuCount !== after.cpuCount
        || before.uptimeSeconds !== after.uptimeSeconds
}

export class MachineCache {
    private readonly machines: Map<string, Machine> = new Map()
    private readonly lastBroadcastAtByMachineId: Map<string, number> = new Map()

    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher,
        private readonly rpcRegistry?: RpcRegistry,
    ) {
    }

    getMachines(): Machine[] {
        return this.mapLive(Array.from(this.machines.values()))
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.mapLive(
            Array.from(this.machines.values()).filter((machine) => machine.namespace === namespace)
        )
    }

    getMachine(machineId: string): Machine | undefined {
        const machine = this.machines.get(machineId)
        return machine ? this.withLiveCapabilities(machine) : undefined
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        const machine = this.machines.get(machineId)
        if (!machine || machine.namespace !== namespace) {
            return undefined
        }
        return this.withLiveCapabilities(machine)
    }

    getOnlineMachines(): Machine[] {
        return this.mapLive(
            Array.from(this.machines.values()).filter((machine) => machine.active)
        )
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.mapLive(
            Array.from(this.machines.values()).filter(
                (machine) => machine.namespace === namespace && machine.active
            )
        )
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        const stored = this.store.machines.getOrCreateMachine(id, metadata, runnerState, namespace)
        return this.refreshMachine(stored.id) ?? (() => { throw new Error('Failed to load machine') })()
    }

    /**
     * Set or clear a machine's user-facing name.
     *
     * An empty `displayName` removes the key so the label falls back to the
     * hostname; the empty string is never stored. Only that one key is touched,
     * leaving everything the CLI reported intact.
     *
     * Reads the raw stored metadata rather than `this.machines`, because the
     * cached view is narrowed by `MachineMetadataSchema`: it strips unknown keys
     * and collapses to `null` when a row fails validation (which is reachable —
     * the CLI's `machine-update-metadata` handler accepts `z.unknown()`). Merging
     * against that view would write those fields out of existence.
     *
     * Retries on version-mismatch. Reading the version straight from the store
     * makes contention with this process impossible (both calls are synchronous
     * SQLite), so the retry only matters when another process writes the same
     * database between the read and the write. `refreshMachine` publishes the
     * `machine-updated` event that makes web clients refetch.
     */
    async renameMachine(machineId: string, displayName: string): Promise<void> {
        for (let attempt = 0; attempt < METADATA_RETRY_ATTEMPTS; attempt += 1) {
            const stored = this.store.machines.getMachine(machineId)
            if (!stored) {
                throw new Error('Machine not found')
            }

            const current = isPlainObject(stored.metadata) ? stored.metadata : {}
            const { displayName: _previous, ...rest } = current
            const newMetadata = displayName.length > 0 ? { ...rest, displayName } : rest

            const result = this.store.machines.updateMachineMetadata(
                machineId,
                newMetadata,
                stored.metadataVersion,
                stored.namespace
            )

            if (result.result === 'error') {
                throw new Error('Failed to update machine metadata')
            }

            this.refreshMachine(machineId)

            if (result.result === 'success') {
                return
            }
        }

        throw new Error('Machine was modified concurrently. Please try again.')
    }

    refreshMachine(machineId: string): Machine | null {
        const stored = this.store.machines.getMachine(machineId)
        if (!stored) {
            const existed = this.machines.delete(machineId)
            if (existed) {
                this.publisher.emit({ type: 'machine-updated', machineId, data: null })
            }
            return null
        }

        const existing = this.machines.get(machineId)

        const metadata = (() => {
            const parsed = MachineMetadataSchema.safeParse(stored.metadata)
            if (!parsed.success) return null
            const data = parsed.data
            const workspaceRoots = Array.from(new Set(
                (data.workspaceRoots ?? []).filter((path) => path.trim().length > 0)
            ))
            return {
                ...data,
                workspaceRoots: workspaceRoots.length > 0 ? workspaceRoots : undefined
            }
        })()

        const runnerState = (() => {
            if (stored.runnerState == null) return null
            const parsed = RunnerStateSchema.safeParse(stored.runnerState)
            return parsed.success ? parsed.data : null
        })()

        const storedActiveAt = stored.activeAt ?? stored.createdAt
        const existingActiveAt = existing?.activeAt ?? 0
        const useStoredActivity = storedActiveAt > existingActiveAt

        const machine: Machine = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: useStoredActivity ? stored.active : (existing?.active ?? stored.active),
            activeAt: useStoredActivity ? storedActiveAt : (existingActiveAt || storedActiveAt),
            metadata,
            metadataVersion: stored.metadataVersion,
            runnerState,
            runnerStateVersion: stored.runnerStateVersion,
            health: existing?.health ?? null
        }

        this.machines.set(machineId, machine)
        const withLive = this.withLiveCapabilities(machine)
        this.publisher.emit({ type: 'machine-updated', machineId, data: withLive })
        // Return the live overlay: callers that fall back to refreshMachine
        // (cold cache on upgrade/restart) must see RPC-registered capabilities,
        // not only persisted metadata.
        return withLive
    }

    /** Overlay live RPC registrations onto advertised metadata capabilities for API/SSE consumers. */
    private withLiveCapabilities(machine: Machine): Machine {
        if (!machine.metadata || !this.rpcRegistry) {
            return machine
        }
        const advertised = machine.metadata.capabilities ?? []
        const live = CURRENT_MACHINE_CAPABILITIES.filter((cap) => (
            this.rpcRegistry!.hasMethod(`${machine.id}:${cap}`)
        ))
        if (live.length === 0) {
            return machine
        }
        const merged = Array.from(new Set([...advertised, ...live]))
        if (
            merged.length === advertised.length
            && merged.every((cap) => advertised.includes(cap))
        ) {
            return machine
        }
        return {
            ...machine,
            metadata: {
                ...machine.metadata,
                capabilities: merged,
            },
        }
    }

    private mapLive(machines: Machine[]): Machine[] {
        return machines.map((machine) => this.withLiveCapabilities(machine))
    }

    reloadAll(): void {
        const machines = this.store.machines.getMachines()
        for (const machine of machines) {
            this.refreshMachine(machine.id)
        }
    }

    handleMachineAlive(payload: MachineAlivePayload): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const machine = this.machines.get(payload.machineId) ?? this.refreshMachine(payload.machineId)
        if (!machine) return

        const wasActive = machine.active
        const previousHealth = machine.health ?? null
        machine.active = true
        machine.activeAt = Math.max(machine.activeAt, t)

        if (payload.health !== undefined) {
            machine.health = parseMachineHealth(payload.health)
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtByMachineId.get(machine.id) ?? 0
        const healthChanged = payload.health !== undefined
            && healthDisplayChanged(previousHealth, machine.health)
        const shouldBroadcast = (!wasActive && machine.active)
            || healthChanged
            || (now - lastBroadcastAt > 10_000)
        if (shouldBroadcast) {
            this.lastBroadcastAtByMachineId.set(machine.id, now)
            this.publisher.emit({
                type: 'machine-updated',
                machineId: machine.id,
                data: this.withLiveCapabilities(machine),
            })
        }
    }

    expireInactive(now: number = Date.now()): void {
        const machineTimeoutMs = 45_000

        for (const machine of this.machines.values()) {
            if (!machine.active) continue
            if (now - machine.activeAt <= machineTimeoutMs) continue
            machine.active = false
            this.publisher.emit({
                type: 'machine-updated',
                machineId: machine.id,
                data: { active: false } satisfies MachinePatch
            })
        }
    }
}

export type { Machine }
