
export type BlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'redacted';

export interface BaseBlock {
    type: BlockType;
}

export interface TextBlock extends BaseBlock {
    type: 'text';
    text: string;
}

export interface ThinkingBlock extends BaseBlock {
    type: 'thinking';
    thinking: string;
    signature?: string;
}

export interface ToolUseBlock extends BaseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
}

export interface ToolResultBlock extends BaseBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: string | Array<TextBlock>;
    is_error?: boolean;
}

export interface RedactedBlock extends BaseBlock {
    type: 'redacted';
    data: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | RedactedBlock;

export type MessageRole = 'user' | 'assistant' | 'agent';

export interface AgentMessage {
    role: MessageRole;
    content: ContentBlock[];
    meta?: Record<string, unknown>;
}

// Wrapper for messages coming from the SyncEngine event stream
// which might be wrapped in an 'agent' role envelope
export interface AgentOutputMessage {
    role: 'agent';
    content: {
        type: 'output';
        data: {
            type: string;
            message?: AgentMessage;
            result?: string;
            error?: string;
            summary?: string;
            [key: string]: unknown;
        };
    };
}

export interface EventMessage {
    role: 'agent';
    content: {
        type: 'event';
        data: {
            type: string;
            mode?: string;
            message?: string;
            [key: string]: unknown;
        };
    };
}

export type MessageContent = AgentMessage | AgentOutputMessage | EventMessage | unknown;
