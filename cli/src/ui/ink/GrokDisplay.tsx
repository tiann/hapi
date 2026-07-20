import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { MessageBuffer, type BufferedMessage } from './messageBuffer';
import { useSwitchControls } from './useSwitchControls';

interface GrokDisplayProps {
    messageBuffer: MessageBuffer;
    logPath?: string;
    onExit?: () => void;
    onSwitchToLocal?: () => void;
}

function extractTag(messages: BufferedMessage[], tag: 'MODEL' | 'MODE'): string | null {
    const prefix = `[${tag}:`;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.type !== 'system') {
            continue;
        }
        if (!message.content.startsWith(prefix)) {
            continue;
        }
        const match = message.content.match(/\[\w+:(.+?)\]/);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

export const GrokDisplay: React.FC<GrokDisplayProps> = ({
    messageBuffer,
    logPath,
    onExit,
    onSwitchToLocal
}) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([]);
    const [model, setModel] = useState<string | null>(null);
    const [permissionMode, setPermissionMode] = useState<string | null>(null);
    const { confirmationMode, actionInProgress } = useSwitchControls({
        onExit,
        onSwitch: onSwitchToLocal
    });
    const { stdout } = useStdout();
    const terminalWidth = stdout.columns || 80;
    const terminalHeight = stdout.rows || 24;

    useEffect(() => {
        setMessages(messageBuffer.getMessages());

        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages);
            const nextModel = extractTag(newMessages, 'MODEL');
            if (nextModel) {
                setModel(nextModel);
            }
            const nextMode = extractTag(newMessages, 'MODE');
            if (nextMode) {
                setPermissionMode(nextMode);
            }
        });

        return () => {
            unsubscribe();
        };
    }, [messageBuffer]);

    const getMessageColor = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta';
            case 'assistant': return 'cyan';
            case 'system': return 'blue';
            case 'tool': return 'yellow';
            case 'result': return 'green';
            case 'status': return 'gray';
            default: return 'white';
        }
    };

    const formatMessage = (msg: BufferedMessage): string => {
        const lines = msg.content.split('\n');
        const maxLineLength = Math.max(1, terminalWidth - 10);
        return lines.map(line => {
            if (line.length <= maxLineLength) return line;
            const chunks: string[] = [];
            for (let i = 0; i < line.length; i += maxLineLength) {
                chunks.push(line.slice(i, i + maxLineLength));
            }
            return chunks.join('\n');
        }).join('\n');
    };

    const visibleMessages = messages.filter((msg) => {
        if (msg.type === 'system' && msg.content.startsWith('[MODEL:')) {
            return false;
        }
        if (msg.type === 'system' && msg.content.startsWith('[MODE:')) {
            return false;
        }
        return true;
    });

    return (
        <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
            <Box
                flexDirection="column"
                width={terminalWidth}
                height={terminalHeight - 4}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                overflow="hidden"
            >
                <Box flexDirection="column" marginBottom={1}>
                    <Text color="gray" bold>Grok Build Agent Messages</Text>
                    <Text color="gray" dimColor>{'-'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                </Box>

                <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
                    {visibleMessages.length === 0 ? (
                        <Text color="gray" dimColor>Waiting for messages...</Text>
                    ) : (
                        visibleMessages
                            .slice(-Math.max(1, terminalHeight - 10))
                            .map((msg) => (
                                <Box key={msg.id} flexDirection="column" marginBottom={1}>
                                    <Text color={getMessageColor(msg.type)} dimColor>
                                        {formatMessage(msg)}
                                    </Text>
                                </Box>
                            ))
                    )}
                </Box>
            </Box>

            <Box
                width={terminalWidth}
                borderStyle="round"
                borderColor={
                    actionInProgress ? 'gray' :
                    confirmationMode === 'exit' ? 'red' :
                    confirmationMode === 'switch' ? 'yellow' :
                    'green'
                }
                paddingX={2}
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
            >
                <Box flexDirection="column" alignItems="center">
                    {actionInProgress === 'exiting' ? (
                        <Text color="gray" bold>
                            Exiting agent...
                        </Text>
                    ) : actionInProgress === 'switching' ? (
                        <Text color="gray" bold>
                            Switching to local mode...
                        </Text>
                    ) : confirmationMode === 'exit' ? (
                        <Text color="red" bold>
                            Press Ctrl-C again to exit the agent
                        </Text>
                    ) : confirmationMode === 'switch' ? (
                        <Text color="yellow" bold>
                            Press space again to switch to local mode
                        </Text>
                    ) : (
                        <Text color="green" bold>
                            Grok Build running {onSwitchToLocal ? '(Space to switch to local, Ctrl-C to exit)' : '(Ctrl-C to exit)'}
                        </Text>
                    )}
                    {(model || permissionMode) && (
                        <Text color="gray" dimColor>
                            {model ? `Model: ${model}` : 'Model: default'}
                            {permissionMode ? ` | Permission: ${permissionMode}` : ''}
                        </Text>
                    )}
                    {process.env.DEBUG && logPath && (
                        <Text color="gray" dimColor>
                            Debug logs: {logPath}
                        </Text>
                    )}
                </Box>
            </Box>
        </Box>
    );
};
