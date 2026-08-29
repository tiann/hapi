import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'

export type CreatableAgentFlavor = typeof CREATABLE_AGENT_FLAVORS[number]
export type CreateAgentVisibility = Record<CreatableAgentFlavor, boolean>

const STORAGE_KEY = 'hapi:newSession:agentVisibility:v1'

export function loadCreateAgentVisibility(): CreateAgentVisibility {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
        return Object.fromEntries(CREATABLE_AGENT_FLAVORS.map((agent) => [agent, stored?.[agent] !== false])) as CreateAgentVisibility
    } catch {
        return Object.fromEntries(CREATABLE_AGENT_FLAVORS.map((agent) => [agent, true])) as CreateAgentVisibility
    }
}

export function saveCreateAgentVisibility(visibility: CreateAgentVisibility): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility))
    } catch {}
}
