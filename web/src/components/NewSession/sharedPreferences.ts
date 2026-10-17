import { useEffect, useState } from 'react'
import { ChatCreationPreferencesSchema, CREATABLE_AGENT_FLAVORS, type ChatCreationPreferences, type ChatLaunchSettings } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import { loadPreferredAgent, loadPreferredLaunchSettings, loadPreferredYoloMode, resolvePreferredLaunchSettings } from './preferences'
import { usesNativePermissionSelect } from '@/lib/codexFamilyPermissionAgents'

export function readBrowserCreationPreferences(knownMachineIds: readonly string[] = []): ChatCreationPreferences {
    const machines: ChatCreationPreferences['machines'] = {}
    let lastMachineId: string | undefined
    let paths: Record<string, string[]> = {}
    try {
        lastMachineId = localStorage.getItem('hapi:lastMachineId') ?? undefined
        paths = JSON.parse(localStorage.getItem('hapi:recentPaths') ?? '{}')
        const machineIds = new Set([...knownMachineIds, ...Object.keys(paths)])
        if (lastMachineId) machineIds.add(lastMachineId)
        const prefix = 'hapi:newSession:launchSettings:v1:'
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(prefix)) machineIds.add(decodeURIComponent(key.slice(prefix.length, key.lastIndexOf(':'))))
        }
        for (const id of machineIds) {
            const agents: Record<string, ChatLaunchSettings> = {}
            for (const agent of CREATABLE_AGENT_FLAVORS) {
                const saved = loadPreferredLaunchSettings(id, agent)
                if (!saved && agent !== loadPreferredAgent()) continue
                const prior = resolvePreferredLaunchSettings(agent, saved, loadPreferredAgent() === agent && loadPreferredYoloMode())
                const settings: ChatLaunchSettings = {
                    model: prior.model === 'auto' ? null : prior.model,
                    permissionMode: prior.permissionMode ?? null,
                    ...(usesNativePermissionSelect(agent) || ['dsh', 'pi'].includes(agent) ? {} : { yolo: loadPreferredYoloMode() })
                }
                if (['claude', 'grok', 'pi'].includes(agent)) settings.effort = prior.effort === 'auto' ? null : prior.effort
                if (['codex', 'opencode'].includes(agent)) settings.modelReasoningEffort = prior.modelReasoningEffort === 'default' ? null : prior.modelReasoningEffort
                agents[agent] = settings
            }
            machines[id] = { directory: paths[id]?.[0], agents }
        }
    } catch { /* Unreadable browser storage has no preferences to migrate. */ }
    return ChatCreationPreferencesSchema.parse({ lastMachineId, lastAgent: loadPreferredAgent(), machines })
}

export function useSharedCreationPreferences(api: ApiClient, machines: readonly { id: string }[]) {
    const [state, setState] = useState<{ data?: ChatCreationPreferences; error?: string }>({})
    const machineIds = machines.map(m => m.id).join(',')
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        let cancelled = false
        setState({})
        // Import only fills missing shared scopes and returns the authoritative
        // result, so an old browser cannot overwrite newer settings.
        api.importCreationPreferences(readBrowserCreationPreferences(machineIds.split(',').filter(Boolean))).then(data => {
            if (!cancelled) setState({ data })
        }, error => {
            if (!cancelled) setState({ error: error instanceof Error ? error.message : 'Failed to load New Chat settings' })
        })
        return () => { cancelled = true }
    }, [api, machineIds, attempt])
    return { ...state, retry: () => setAttempt(value => value + 1) }
}
