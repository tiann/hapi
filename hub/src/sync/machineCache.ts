import type { Machine, MachinePatch } from '@hapi/protocol/types'
import { MachineHealthSchema, MachineMetadataSchema, RunnerStateSchema } from '@hapi/protocol/schemas'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'

type MachineAlivePayload = {
    machineId: string
    time: number
    health?: unknown
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
}

export class MachineCache {
    private readonly machines: Map<string, Machine> = new Map()
    private readonly lastBroadcastAtByMachineId: Map<string, number> = new Map()

    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher
    ) {
    }

    getMachines(): Machine[] {
        return Array.from(this.machines.values())
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.getMachines().filter((machine) => machine.namespace === namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machines.get(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        const machine = this.machines.get(machineId)
        if (!machine || machine.namespace !== namespace) {
            return undefined
        }
        return machine
    }

    getOnlineMachines(): Machine[] {
        return this.getMachines().filter((machine) => machine.active)
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.getMachinesByNamespace(namespace).filter((machine) => machine.active)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        const stored = this.store.machines.getOrCreateMachine(id, metadata, runnerState, namespace)
        return this.refreshMachine(stored.id) ?? (() => { throw new Error('Failed to load machine') })()
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
        this.publisher.emit({ type: 'machine-updated', machineId, data: machine })
        return machine
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
            this.publisher.emit({ type: 'machine-updated', machineId: machine.id, data: machine })
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
