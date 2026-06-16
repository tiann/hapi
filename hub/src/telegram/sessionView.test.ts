import { describe, expect, it } from 'bun:test'
import type { Machine, Session } from '../sync/syncEngine'
import { formatReadyNotification, formatSessionNotification } from './sessionView'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1234567890',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: '/home/alice/infra',
            host: 'devbox.local',
            homeDir: '/home/alice',
            name: 'rotate HAPI secrets',
            machineId: 'machine-1',
            flavor: 'codex'
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

function createMachine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: 'devbox.local',
            platform: 'linux',
            happyCliVersion: '0.1.0',
            displayName: 'Work Laptop'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
        ...overrides
    }
}

describe('Telegram session notifications', () => {
    it('adds session, machine, and path context to ready notifications', () => {
        expect(formatReadyNotification(createSession(), createMachine())).toBe([
            'Ready: rotate HAPI secrets on Work Laptop',
            '',
            'Codex is waiting for your command',
            'Session: rotate HAPI secrets',
            'Path: ~/infra'
        ].join('\n'))
    })

    it('keeps the previous ready notification text when context is unavailable', () => {
        const session = createSession({ metadata: null })

        expect(formatReadyNotification(session)).toBe([
            "It's ready!",
            '',
            'Agent is waiting for your command'
        ].join('\n'))
    })

    it('adds session, machine, and path context to permission notifications without losing tool details', () => {
        const session = createSession({
            agentState: {
                requests: {
                    req1: {
                        tool: 'Bash',
                        arguments: { command: 'bun test' },
                        createdAt: 1
                    }
                }
            }
        })

        expect(formatSessionNotification(session, createMachine())).toBe([
            'Action required: rotate HAPI secrets on Work Laptop',
            '',
            'Codex requests permission',
            'Session: rotate HAPI secrets',
            'Path: ~/infra',
            'Tool: Bash',
            'Command: bun test'
        ].join('\n'))
    })
})
