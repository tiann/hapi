import { describe, expect, it } from 'bun:test'
import { MODEL_MODES, PERMISSION_MODES } from './modes'
import {
    AgentStateCompletedRequestSchema,
    MetadataSchema,
    ModelModeSchema,
    PermissionModeSchema,
    SessionSchema,
    SyncEventSchema,
    WorktreeMetadataSchema
} from './schemas'

describe('PermissionModeSchema', () => {
    it('accepts all known permission modes', () => {
        for (const mode of PERMISSION_MODES) {
            expect(PermissionModeSchema.parse(mode)).toBe(mode)
        }
    })

    it('rejects unknown permission modes', () => {
        expect(PermissionModeSchema.safeParse('super-admin').success).toBe(false)
    })
})

describe('ModelModeSchema', () => {
    it('accepts all known model modes', () => {
        for (const mode of MODEL_MODES) {
            expect(ModelModeSchema.parse(mode)).toBe(mode)
        }
    })

    it('rejects unknown model modes', () => {
        expect(ModelModeSchema.safeParse('haiku').success).toBe(false)
    })
})

describe('WorktreeMetadataSchema', () => {
    it('accepts minimal payload', () => {
        const result = WorktreeMetadataSchema.safeParse({
            basePath: '/repo',
            branch: 'main',
            name: 'root'
        })

        expect(result.success).toBe(true)
    })

    it('accepts full payload', () => {
        const result = WorktreeMetadataSchema.safeParse({
            basePath: '/repo',
            branch: 'feature/test',
            name: 'wt-feature',
            worktreePath: '/repo/.worktrees/feature-test',
            createdAt: 1700000000000
        })

        expect(result.success).toBe(true)
    })

    it('rejects invalid field types', () => {
        const result = WorktreeMetadataSchema.safeParse({
            basePath: '/repo',
            branch: 'main',
            name: 'root',
            createdAt: '1700000000000'
        })

        expect(result.success).toBe(false)
    })
})

describe('MetadataSchema', () => {
    it('accepts minimal payload', () => {
        const result = MetadataSchema.safeParse({
            path: '/repo',
            host: 'devbox'
        })

        expect(result.success).toBe(true)
    })

    it('accepts full payload', () => {
        const result = MetadataSchema.safeParse({
            path: '/repo',
            host: 'devbox',
            version: '1.0.0',
            name: 'session-name',
            os: 'linux',
            summary: {
                text: 'ready',
                updatedAt: 1700000000000
            },
            machineId: 'machine-1',
            claudeSessionId: 'claude-1',
            codexSessionId: 'codex-1',
            geminiSessionId: 'gemini-1',
            opencodeSessionId: 'opencode-1',
            tools: ['bash', 'git'],
            slashCommands: ['/help'],
            homeDir: '/home/allen',
            happyHomeDir: '/home/allen/.hapi',
            happyLibDir: '/home/allen/.hapi/lib',
            happyToolsDir: '/home/allen/.hapi/tools',
            startedFromRunner: true,
            hostPid: 1234,
            startedBy: 'runner',
            lifecycleState: 'active',
            lifecycleStateSince: 1700000000001,
            archivedBy: 'system',
            archiveReason: 'idle',
            flavor: 'claude',
            worktree: {
                basePath: '/repo',
                branch: 'feature/test',
                name: 'wt-feature',
                worktreePath: '/repo/.worktrees/feature-test',
                createdAt: 1700000000002
            }
        })

        expect(result.success).toBe(true)
    })

    it('rejects invalid field values', () => {
        const result = MetadataSchema.safeParse({
            path: '/repo',
            host: 'devbox',
            startedBy: 'daemon'
        })

        expect(result.success).toBe(false)
    })
})

describe('AgentStateCompletedRequestSchema', () => {
    const baseRequest = {
        tool: 'request_user_input',
        arguments: { prompt: 'Continue?' },
        status: 'approved' as const
    }

    it('accepts flat answers format', () => {
        const result = AgentStateCompletedRequestSchema.safeParse({
            ...baseRequest,
            answers: {
                q1: ['yes', 'proceed']
            }
        })

        expect(result.success).toBe(true)
    })

    it('accepts nested answers format', () => {
        const result = AgentStateCompletedRequestSchema.safeParse({
            ...baseRequest,
            answers: {
                q1: { answers: ['yes'] },
                q2: { answers: ['no'] }
            }
        })

        expect(result.success).toBe(true)
    })

    it('rejects invalid decision values', () => {
        const result = AgentStateCompletedRequestSchema.safeParse({
            ...baseRequest,
            decision: 'maybe'
        })

        expect(result.success).toBe(false)
    })
})

describe('SessionSchema', () => {
    const baseSession = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1700000000000,
        updatedAt: 1700000000001,
        active: true,
        activeAt: 1700000000001,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 1700000000001
    }

    it('accepts nullable metadata and agentState', () => {
        const result = SessionSchema.safeParse(baseSession)

        expect(result.success).toBe(true)
    })

    it('rejects invalid permissionMode', () => {
        const result = SessionSchema.safeParse({
            ...baseSession,
            permissionMode: 'admin'
        })

        expect(result.success).toBe(false)
    })
})

describe('SyncEventSchema', () => {
    it('accepts session-added event', () => {
        const result = SyncEventSchema.safeParse({
            type: 'session-added',
            sessionId: 'session-1'
        })

        expect(result.success).toBe(true)
    })

    it('accepts message-received event', () => {
        const result = SyncEventSchema.safeParse({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'message-1',
                seq: 1,
                localId: null,
                content: { text: 'hello' },
                createdAt: 1700000000000
            }
        })

        expect(result.success).toBe(true)
    })

    it('accepts toast event', () => {
        const result = SyncEventSchema.safeParse({
            type: 'toast',
            data: {
                title: 'Done',
                body: 'Task complete',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        })

        expect(result.success).toBe(true)
    })

    it('rejects unknown event type', () => {
        const result = SyncEventSchema.safeParse({
            type: 'session-paused',
            sessionId: 'session-1'
        })

        expect(result.success).toBe(false)
    })
})
