import React, { useMemo, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { ResumableSession } from '@hapi/protocol'
import {
    filterResumeSessions,
    formatResumeSessionRelativeTime,
    getResumeSessionName,
    getResumeSessionState,
    normalizeScrollOffset,
    reducePickerState,
    type PickerState
} from './resumeSessionPickerState'

type ExtendedKey = {
    upArrow?: boolean
    downArrow?: boolean
    return?: boolean
    escape?: boolean
    backspace?: boolean
    delete?: boolean
    ctrl?: boolean
    pageUp?: boolean
    pageDown?: boolean
    home?: boolean
    end?: boolean
    name?: string
    sequence?: string
}

export type ResumeSessionPickerProps = {
    sessions: ResumableSession[]
    onSelect: (sessionId: string) => void
    onCancel: () => void
}

function formatSessionLine(session: ResumableSession, width: number): string {
    const state = getResumeSessionState(session)
    const time = formatResumeSessionRelativeTime(session.updatedAt)
    const alignedPrefix = `${time.padStart(10)}  ${session.flavor.padEnd(8)} ${state.padEnd(8)} `
    const prefix = width - alignedPrefix.length >= 12
        ? alignedPrefix
        : `${time} ${state} `
    return prefix + getResumeSessionName(session).replace(/[\r\n\t]+/g, ' ')
}

function isPrintableInput(input: string, key: ExtendedKey): boolean {
    if (key.ctrl || key.return || key.escape || key.backspace || key.delete) return false
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end) return false
    if (input.length !== 1) return false
    return input >= ' ' && input !== '\u007f'
}

export const ResumeSessionPicker: React.FC<ResumeSessionPickerProps> = ({
    sessions,
    onSelect,
    onCancel
}) => {
    const { stdout } = useStdout()
    const terminalWidth = stdout.columns || 80
    const terminalHeight = stdout.rows || 24
    const visibleCount = Math.min(16, Math.max(1, terminalHeight - 9))
    const [state, setState] = useState<PickerState>({
        query: '',
        selectedIndex: 0,
        scrollOffset: 0
    })

    const filteredSessions = useMemo(
        () => filterResumeSessions(sessions, state.query),
        [sessions, state.query]
    )
    const selectedIndex = filteredSessions.length === 0
        ? 0
        : Math.min(state.selectedIndex, filteredSessions.length - 1)
    const scrollOffset = normalizeScrollOffset(
        selectedIndex,
        state.scrollOffset,
        visibleCount,
        filteredSessions.length
    )
    const visibleSessions = filteredSessions.slice(scrollOffset, scrollOffset + visibleCount)
    const selectedSession = filteredSessions[selectedIndex]

    useInput((input, key: ExtendedKey) => {
        if (key.ctrl && input === 'c') {
            onCancel()
            return
        }

        if (key.return) {
            const selected = filteredSessions[selectedIndex]
            if (selected) {
                onSelect(selected.sessionId)
            }
            return
        }

        if (key.escape) {
            if (state.query.length === 0) {
                onCancel()
                return
            }
            setState((current) => reducePickerState(current, {
                type: 'key',
                key: 'escape'
            }, {
                itemCount: filteredSessions.length,
                visibleCount
            }))
            return
        }

        const keyName = key.name
        const mappedKey =
            key.upArrow || keyName === 'up' ? 'up'
                : key.downArrow || keyName === 'down' ? 'down'
                    : key.pageUp || keyName === 'pageup' ? 'pageUp'
                        : key.pageDown || keyName === 'pagedown' ? 'pageDown'
                            : key.home || keyName === 'home' ? 'home'
                                : key.end || keyName === 'end' ? 'end'
                                    : key.backspace || key.delete || keyName === 'backspace' || keyName === 'delete' ? 'backspace'
                                        : null

        if (mappedKey) {
            setState((current) => reducePickerState(current, {
                type: 'key',
                key: mappedKey
            }, {
                itemCount: filteredSessions.length,
                visibleCount
            }))
            return
        }

        if (isPrintableInput(input, key)) {
            setState((current) => reducePickerState(current, {
                type: 'char',
                value: input
            }, {
                itemCount: filteredSessions.length,
                visibleCount
            }))
        }
    })

    const shownStart = filteredSessions.length === 0 ? 0 : scrollOffset + 1
    const shownEnd = Math.min(filteredSessions.length, scrollOffset + visibleSessions.length)
    const firstMessage = selectedSession?.firstUserMessage

    return (
        <Box flexDirection="column" width={terminalWidth}>
            <Text bold>Resumable sessions</Text>
            <Text color="gray" wrap="truncate">
                Search: <Text color={state.query ? 'cyan' : 'gray'}>{state.query || 'type to filter'}</Text>
            </Text>
            <Text color="gray">
                {filteredSessions.length === 0
                    ? 'No matching sessions'
                    : `${shownStart}-${shownEnd} of ${filteredSessions.length}`}
            </Text>
            <Box flexDirection="column" marginTop={1}>
                {visibleSessions.map((session, index) => {
                    const absoluteIndex = scrollOffset + index
                    const selected = absoluteIndex === selectedIndex
                    return (
                        <Text
                            key={session.sessionId}
                            wrap="truncate"
                            color={selected ? 'cyan' : undefined}
                        >
                            {selected ? '> ' : '  '}
                            {formatSessionLine(session, terminalWidth - 2)}
                        </Text>
                    )
                })}
            </Box>
            <Box marginTop={1}>
                <Text color="gray" wrap="truncate-middle">ID: {selectedSession?.sessionId ?? '-'}</Text>
            </Box>
            <Box>
                <Text color="gray" wrap="truncate">First message: {firstMessage || '-'}</Text>
            </Box>
            <Box>
                <Text color="gray" wrap="truncate">Directory: {selectedSession?.directory ?? '-'}</Text>
            </Box>
            <Box>
                <Text color="gray" wrap="truncate">Up/Down move | Enter resume | Esc clear/cancel | PageUp/PageDown scroll | Ctrl-C cancel</Text>
            </Box>
        </Box>
    )
}
