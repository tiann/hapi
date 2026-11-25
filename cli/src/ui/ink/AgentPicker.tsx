import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { getFlavorLabel, type AgentAvailabilityEntry, type AgentFlavor } from '@hapi/protocol'

export type AgentPickerProps = {
    agents: readonly AgentAvailabilityEntry[]
    onSelect: (agent: AgentFlavor) => void
    onCancel: (exitCode: 0 | 130) => void
}

export function formatAgentChoice(entry: AgentAvailabilityEntry): string {
    const label = `${getFlavorLabel(entry.agent)} (${entry.agent})`
    if (entry.available) return label
    const reason = entry.reason === 'invalid_configuration'
        ? 'invalid configuration'
        : 'not installed or not on PATH'
    return `${label} — ${reason}`
}

export function AgentPicker({ agents, onSelect, onCancel }: AgentPickerProps): React.ReactElement {
    const available = agents.filter((entry) => entry.available)
    const [selectedIndex, setSelectedIndex] = useState(0)
    const selected = available[selectedIndex]?.agent

    useInput((input, key) => {
        if (key.ctrl && input === 'c') {
            onCancel(130)
        } else if (key.escape) {
            onCancel(0)
        } else if (key.upArrow) {
            setSelectedIndex((index) => Math.max(0, index - 1))
        } else if (key.downArrow) {
            setSelectedIndex((index) => Math.min(available.length - 1, index + 1))
        } else if (key.return && selected) {
            onSelect(selected)
        }
    })

    return (
        <Box flexDirection="column">
            <Text bold>Choose an agent</Text>
            <Box flexDirection="column" marginY={1}>
                {agents.map((entry) => (
                    <Text
                        key={entry.agent}
                        color={!entry.available ? 'gray' : entry.agent === selected ? 'cyan' : undefined}
                    >
                        {entry.agent === selected ? '> ' : '  '}{formatAgentChoice(entry)}
                    </Text>
                ))}
            </Box>
            <Text color="gray">Up/Down move | Enter start | Esc / Ctrl-C cancel</Text>
        </Box>
    )
}
