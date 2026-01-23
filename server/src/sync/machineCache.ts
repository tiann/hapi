import { z } from 'zod'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'

const machineMetadataSchema = z.object({
    host: z.string().optional(),
    platform: z.string().optional(),
    happyCliVersion: z.string().optional(),
    displayName: z.string().optional(),
    homeDir: z.string().optional(),
    happyHomeDir: z.string().optional(),
    happyLibDir: z.string().optional()
})

export interface Machine {
    id: string
    namespace: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: {
        host: string
        platform: string
        happyCliVersion: string
        displayName?: string
        homeDir?: string
        happyHomeDir?: string
        happyLibDir?: string
    } | null
    metadataVersion: number
    runnerState: unknown | null
    runnerStateVersion: number
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
            const parsed = machineMetadataSchema.safeParse(stored.metadata)
            if (!parsed.success) return null
            const data = parsed.data
            const host = typeof data.host === 'string' ? data.host : 'unknown'
            const platform = typeof data.platform === 'string' ? data.platform : 'unknown'
            const happyCliVersion = typeof data.happyCliVersion === 'string' ? data.happyCliVersion : 'unknown'
            const displayName = typeof data.displayName === 'string' ? data.displayName : undefined
            const homeDir = typeof data.homeDir === 'string' ? data.homeDir : undefined
            const happyHomeDir = typeof data.happyHomeDir === 'string' ? data.happyHomeDir : undefined
            const happyLibDir = typeof data.happyLibDir === 'string' ? data.happyLibDir : undefined
            return { host, platform, happyCliVersion, displayName, homeDir, happyHomeDir, happyLibDir }
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
            runnerState: stored.runnerState,
            runnerStateVersion: stored.runnerStateVersion
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

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const machine = this.machines.get(payload.machineId) ?? this.refreshMachine(payload.machineId)
        if (!machine) return

        const wasActive = machine.active
        machine.active = true
        machine.activeAt = Math.max(machine.activeAt, t)

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtByMachineId.get(machine.id) ?? 0
        const shouldBroadcast = (!wasActive && machine.active) || (now - lastBroadcastAt > 10_000)
        if (shouldBroadcast) {
            this.lastBroadcastAtByMachineId.set(machine.id, now)
            this.publisher.emit({ type: 'machine-updated', machineId: machine.id, data: { activeAt: machine.activeAt } })
        }
    }

    expireInactive(now: number = Date.now()): void {
        const machineTimeoutMs = 45_000

        for (const machine of this.machines.values()) {
            if (!machine.active) continue
            if (now - machine.activeAt <= machineTimeoutMs) continue
            machine.active = false
            this.publisher.emit({ type: 'machine-updated', machineId: machine.id, data: { active: false } })
        }
    }
}
