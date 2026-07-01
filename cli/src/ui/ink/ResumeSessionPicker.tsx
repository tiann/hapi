import React, { useMemo, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { getFlavorLabel, type ResumableSession } from '@hapi/protocol'
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

function isWideCodePoint(codePoint: number): boolean {
    return (codePoint >= 0x1100 && codePoint <= 0x115f)
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
}

function columnWidth(value: string): number {
    let width = 0
    for (const char of value) {
        const codePoint = char.codePointAt(0) ?? 0
        width += isWideCodePoint(codePoint) ? 2 : 1
    }
    return width
}

function sliceColumns(value: string, maxWidth: number): string {
    let width = 0
    let result = ''
    for (const char of value) {
        const codePoint = char.codePointAt(0) ?? 0
        const charWidth = isWideCodePoint(codePoint) ? 2 : 1
        if (width + charWidth > maxWidth) break
        result += char
        width += charWidth
    }
    return result
}

function truncateText(value: string, maxLength: number): string {
    if (maxLength <= 0) return ''
    if (columnWidth(value) <= maxLength) return value
    if (maxLength <= 3) return '.'.repeat(maxLength)
    return `${sliceColumns(value, maxLength - 3)}...`
}

function padEndColumns(value: string, width: number): string {
    const padding = Math.max(0, width - columnWidth(value))
    return `${value}${' '.repeat(padding)}`
}

function formatSessionLine(session: ResumableSession, width: number): string {
    const state = getResumeSessionState(session)
    const time = formatResumeSessionRelativeTime(session.updatedAt).padStart(10)
    const prefix = `${time}  ${getFlavorLabel(session.flavor).padEnd(12)} ${state.padEnd(8)} `
    const nameBudget = Math.max(12, width - prefix.length)
    const name = truncateText(getResumeSessionName(session), nameBudget)
    return padEndColumns(`${prefix}${name}`, width)
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
    const visibleCount = Math.min(16, Math.max(5, terminalHeight - 8))
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

    const width = Math.max(40, terminalWidth - 4)
    const shownStart = filteredSessions.length === 0 ? 0 : scrollOffset + 1
    const shownEnd = Math.min(filteredSessions.length, scrollOffset + visibleSessions.length)
    const selectedTitle = selectedSession?.name ?? selectedSession?.summary ?? selectedSession?.sessionId

    return (
        <Box flexDirection="column" width={terminalWidth}>
            <Text bold>Resumable sessions</Text>
            <Text color="gray">
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
                            color={selected ? 'cyan' : undefined}
                        >
                            {selected ? '> ' : '  '}
                            {formatSessionLine(session, width - 2)}
                        </Text>
                    )
                })}
            </Box>
            <Box marginTop={1}>
                <Text color="gray">
                    Title: {selectedTitle ? truncateText(selectedTitle, Math.max(10, terminalWidth - 11)) : '-'}
                </Text>
            </Box>
            <Box>
                <Text color="gray">
                    Directory: {selectedSession ? truncateText(selectedSession.directory, Math.max(10, terminalWidth - 15)) : '-'}
                </Text>
            </Box>
            <Box>
                <Text color="gray">Up/Down move | PageUp/PageDown scroll | type search | Enter resume | Esc clear/cancel | Ctrl-C cancel</Text>
            </Box>
        </Box>
    )
}
