import { describe, expect, test } from 'bun:test'
import { resolveChatCreation, rememberChatCreation, type ChatCreationPreferences } from './sessionCreation'

const saved: ChatCreationPreferences = {
    lastMachineId: 'm1', lastAgent: 'codex',
    machines: { m1: { directory: '/repo', agents: { codex: { model: 'gpt-test', permissionMode: 'read-only', serviceTier: 'fast', collaborationMode: 'plan' }, claude: { model: 'opus', yolo: true } } } }
}

describe('shared chat creation preferences', () => {
    test('uses saved machine, directory and agent settings', () => {
        expect(resolveChatCreation({}, saved, ['m1'])).toMatchObject({ machineId: 'm1', directory: '/repo', agent: 'codex', model: 'gpt-test', permissionMode: 'read-only', serviceTier: 'fast' })
    })
    test('disabling YOLO preserves an inherited restrictive permission mode', () => {
        expect(resolveChatCreation({ yolo: false }, saved, ['m1']).permissionMode).toBe('read-only')
    })
    test('cross-agent creation only inherits that agent settings', () => {
        expect(resolveChatCreation({ agent: 'claude', yolo: false }, saved, ['m1'])).toMatchObject({ agent: 'claude', model: 'opus', yolo: false })
        expect(resolveChatCreation({ agent: 'claude' }, saved, ['m1']).serviceTier).toBeUndefined()
    })
    test('preserves explicit clears, false and default choices', () => {
        expect(resolveChatCreation({ model: null, serviceTier: 'standard', collaborationMode: 'default', permissionMode: 'default', yolo: false }, saved, ['m1'])).toMatchObject({ model: null, serviceTier: 'standard', collaborationMode: 'default', permissionMode: 'default', yolo: false })
    })
    test('uses normal defaults without saved values and requires a directory', () => {
        expect(resolveChatCreation({ directory: '/repo' }, { machines: {} }, ['m1'])).toMatchObject({ machineId: 'm1', agent: 'claude', directory: '/repo', sessionType: 'simple' })
        expect(() => resolveChatCreation({}, { machines: {} }, ['m1'])).toThrow('directory')
    })
    test('rejects incompatible options rather than broadening permissions', () => {
        expect(() => resolveChatCreation({ agent: 'codex', permissionMode: 'bypassPermissions' }, saved, ['m1'])).toThrow('permission')
        expect(() => resolveChatCreation({ agent: 'claude', serviceTier: 'fast' }, saved, ['m1'])).toThrow('serviceTier')
        expect(() => resolveChatCreation({ permissionMode: 'safe-yolo' }, saved, ['m1'])).toThrow('permission')
        expect(() => resolveChatCreation({ permissionMode: 'read-only', yolo: true }, saved, ['m1'])).toThrow('conflict')
    })
    test('keeps agent scopes and replaces cleared settings on successful creation', () => {
        const resolved = resolveChatCreation({ model: null }, saved, ['m1'])
        const next = rememberChatCreation(saved, resolved)
        expect(next.machines.m1.agents.codex.model).toBeNull()
        expect(next.machines.m1.agents.claude).toEqual(saved.machines.m1.agents.claude)
        expect(saved.machines.m1.agents.codex.model).toBe('gpt-test')
    })
})
