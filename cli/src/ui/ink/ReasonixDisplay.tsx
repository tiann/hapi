import React, { useEffect, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'
import { useSwitchControls } from './useSwitchControls'

interface ReasonixDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void | Promise<void>
    onSwitchToLocal?: () => void | Promise<void>
}

export const ReasonixDisplay: React.FC<ReasonixDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const { stdout } = useStdout()
    const width = stdout.columns || 80
    const height = stdout.rows || 24
    // Reasonix currently has no local HAPI launcher. Do not expose the generic
    // space-to-switch control, which would otherwise claim a handoff exists.
    const { confirmationMode, actionInProgress } = useSwitchControls({ onExit })

    useEffect(() => {
        setMessages(messageBuffer.getMessages())
        return messageBuffer.onUpdate(setMessages)
    }, [messageBuffer])

    const color = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta'
            case 'assistant': return 'cyan'
            case 'tool': return 'yellow'
            case 'result': return 'green'
            case 'status': return 'gray'
            default: return 'blue'
        }
    }

    const visible = messages.filter((message) =>
        message.type !== 'system'
        || (!message.content.startsWith('[MODEL:') && !message.content.startsWith('[MODE:')))

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Box flexDirection="column" width={width} height={height - 4} borderStyle="round" borderColor="gray" paddingX={1} overflow="hidden">
                <Text color="gray" bold>Reasonix Agent Messages</Text>
                <Text color="gray" dimColor>{'-'.repeat(Math.min(Math.max(1, width - 4), 60))}</Text>
                <Box flexDirection="column" height={height - 7} overflow="hidden">
                    {visible.length === 0
                        ? <Text color="gray" dimColor>Waiting for messages...</Text>
                        : visible.slice(-Math.max(1, height - 8)).map((message) => (
                            <Text key={message.id} color={color(message.type)} dimColor>{message.content}</Text>
                        ))}
                </Box>
            </Box>
            <Box width={width} borderStyle="round" borderColor={actionInProgress ? 'gray' : confirmationMode === 'exit' ? 'red' : 'green'} paddingX={2} justifyContent="center">
                <Text color={confirmationMode === 'exit' ? 'red' : 'green'} bold>
                    {actionInProgress === 'exiting'
                        ? 'Exiting Reasonix...'
                        : confirmationMode === 'exit'
                            ? 'Press Ctrl-C again to exit Reasonix'
                            : 'Reasonix running (Ctrl-C to exit)'}
                </Text>
                {process.env.DEBUG && logPath ? <Text color="gray" dimColor> {logPath}</Text> : null}
            </Box>
        </Box>
    )
}
