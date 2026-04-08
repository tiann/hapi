import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { MachineSessionProfiles } from '@hapi/protocol'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMachinesRoutes } from './machines'

function createMachine(): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1
    }
}

function createApp() {
    const machine = createMachine()
    const machineSessionProfiles: MachineSessionProfiles = {
        profiles: [
            {
                id: 'ice',
                label: 'Ice',
                agent: 'codex',
                defaults: {
                    permissionMode: 'safe-yolo'
                }
            }
        ],
        defaults: {
            codexProfileId: 'ice'
        }
    }
    const getMachineSessionProfilesCalls: string[] = []
    const updateMachineSessionProfilesCalls: Array<[string, MachineSessionProfiles]> = []
    const spawnSessionCalls: unknown[] = []

    const engine = {
        getMachine: (machineId: string) => machineId === machine.id ? machine : null,
        getMachineSessionProfiles: async (machineId: string) => {
            getMachineSessionProfilesCalls.push(machineId)
            return machineSessionProfiles
        },
        updateMachineSessionProfiles: async (machineId: string, payload: MachineSessionProfiles) => {
            updateMachineSessionProfilesCalls.push([machineId, payload])
            return payload
        },
        spawnSession: async (...args: unknown[]) => {
            spawnSessionCalls.push(args)
            return { type: 'success', sessionId: 'session-1' as const }
        }
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

    return {
        app,
        getMachineSessionProfilesCalls,
        updateMachineSessionProfilesCalls,
        spawnSessionCalls,
        machineSessionProfiles
    }
}

describe('machines routes', () => {
    it('returns machine session profiles', async () => {
        const { app, getMachineSessionProfilesCalls, machineSessionProfiles } = createApp()

        const response = await app.request('/api/machines/machine-1/session-profiles')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(machineSessionProfiles)
        expect(getMachineSessionProfilesCalls).toEqual(['machine-1'])
    })

    it('updates machine session profiles', async () => {
        const { app, updateMachineSessionProfilesCalls } = createApp()
        const payload: MachineSessionProfiles = {
            profiles: [],
            defaults: {
                codexProfileId: null
            }
        }

        const response = await app.request('/api/machines/machine-1/session-profiles', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(payload)
        expect(updateMachineSessionProfilesCalls).toEqual([['machine-1', payload]])
    })

    it('forwards permissionMode and profileId in spawn requests', async () => {
        const { app, spawnSessionCalls } = createApp()

        const response = await app.request('/api/machines/machine-1/spawn', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'codex',
                model: 'gpt-5.4',
                modelReasoningEffort: 'high',
                permissionMode: 'safe-yolo',
                sessionType: 'worktree',
                worktreeName: 'feature-x',
                effort: 'max',
                profileId: 'ice'
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-1' })
        expect(spawnSessionCalls).toEqual([[
            'machine-1',
            '/tmp/project',
            'codex',
            'gpt-5.4',
            'high',
            'safe-yolo',
            'worktree',
            'feature-x',
            undefined,
            'max',
            'ice'
        ]])
    })
})
