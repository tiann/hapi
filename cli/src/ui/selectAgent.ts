import React from 'react'
import { render } from 'ink'
import { CREATABLE_AGENT_FLAVORS, type AgentFlavor } from '@hapi/protocol'
import { getAgentAvailability } from '@/agent/agentAvailability'
import { AgentPicker, formatAgentChoice } from './ink/AgentPicker'
import { restoreTerminalState } from './terminalState'

export type AgentSelection =
    | { type: 'selected'; agent: AgentFlavor }
    | { type: 'exit'; exitCode: 0 | 1 | 130 }

export async function selectAgent(): Promise<AgentSelection> {
    const agents = [...CREATABLE_AGENT_FLAVORS].sort().map((agent) => (
        getAgentAvailability(agent, process.env, 'terminal')
    ))
    if (!agents.some((entry) => entry.available)) {
        console.error('No supported agents are available:')
        for (const entry of agents) {
            console.error(`  ${formatAgentChoice(entry)}`)
        }
        console.error('Install an agent or fix its configuration, then run hapi again or use hapi <agent> [options].')
        return { type: 'exit', exitCode: 1 }
    }

    let selection: AgentSelection = { type: 'exit', exitCode: 0 }
    let settled = false
    const complete = (result: AgentSelection) => {
        if (settled) return
        settled = true
        selection = result
        instance.unmount()
    }
    const instance = render(React.createElement(AgentPicker, {
        agents,
        onSelect: (agent) => complete({ type: 'selected', agent }),
        onCancel: (exitCode) => complete({ type: 'exit', exitCode })
    }), {
        patchConsole: false,
        exitOnCtrlC: false
    })

    try {
        await instance.waitUntilExit()
        return selection
    } finally {
        instance.unmount()
        restoreTerminalState()
    }
}
