import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { readBrowserCreationPreferences, useSharedCreationPreferences } from './sharedPreferences'
import { savePreferredAgent, savePreferredLaunchSettings, savePreferredYoloMode } from './preferences'
import type { ChatCreationPreferences } from '@hapi/protocol'

beforeEach(() => localStorage.clear())

describe('shared New Chat settings', () => {
    it('migrates machine-agent scopes and legacy permission semantics', () => {
        savePreferredAgent('claude'); savePreferredYoloMode(true)
        savePreferredLaunchSettings('m1', 'codex', { model: 'gpt-test', cursorSelectedBase: 'auto', effort: 'auto', modelReasoningEffort: 'high', permissionMode: 'read-only' })
        localStorage.setItem('hapi:recentPaths', JSON.stringify({ m1: ['/repo'] }))
        const migrated = readBrowserCreationPreferences(['m1', 'm2'])
        expect(migrated.machines.m1.directory).toBe('/repo')
        expect(migrated.machines.m1.agents.codex).toMatchObject({ model: 'gpt-test', modelReasoningEffort: 'high', permissionMode: 'read-only' })
        expect(migrated.machines.m2.agents.claude.permissionMode).toBe('bypassPermissions')
    })
    it('uses the hub response even when local defaults disagree', async () => {
        savePreferredAgent('claude')
        const shared: ChatCreationPreferences = { lastAgent: 'codex', lastMachineId: 'm2', machines: { m2: { directory: '/shared', agents: { codex: { serviceTier: 'fast', collaborationMode: 'plan' } } } } }
        const importCreationPreferences = vi.fn().mockResolvedValue(shared)
        const api = { importCreationPreferences } as unknown as ApiClient
        const { result } = renderHook(() => useSharedCreationPreferences(api, [{ id: 'm2' }]))
        await waitFor(() => expect(result.current.data).toEqual(shared))
        expect(importCreationPreferences).toHaveBeenCalledTimes(1)
    })
    it('reports a failed import instead of silently launching from browser defaults', async () => {
        const api = { importCreationPreferences: vi.fn().mockRejectedValue(new Error('Hub offline')) } as unknown as ApiClient
        const { result } = renderHook(() => useSharedCreationPreferences(api, []))
        await waitFor(() => expect(result.current.error).toBe('Hub offline'))
        expect(result.current.data).toBeUndefined()
    })
    it('lets the form retry a failed preference load', async () => {
        const api = { importCreationPreferences: vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ machines: {} }) } as unknown as ApiClient
        const { result } = renderHook(() => useSharedCreationPreferences(api, []))
        await waitFor(() => expect(result.current.error).toBe('Offline'))
        act(() => result.current.retry())
        await waitFor(() => expect(result.current.data).toEqual({ machines: {} }))
        expect(result.current.error).toBeUndefined()
    })
})
