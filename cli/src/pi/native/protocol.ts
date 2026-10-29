/** Private loopback protocol; never carries terminal output. */
export const PI_NATIVE_PROTOCOL_VERSION = 1;
// A 50 MiB HAPI image batch grows to about 67 MiB after base64 encoding.
export const PI_NATIVE_MAX_FRAME_BYTES = 96 * 1024 * 1024;
export const PI_NATIVE_COMMANDS = [
    'get_state', 'get_entries', 'get_available_models', 'get_commands',
    'get_session_stats', 'set_model', 'set_thinking_level', 'prompt', 'steer',
    'follow_up', 'abort', 'bind_hapi_session'
] as const;

export interface PiNativeEvent {
    sessionId: string;
    event: Record<string, unknown>;
}

export interface PiNativeRequest {
    kind: 'request';
    id: string;
    sessionId: string;
    command: Record<string, unknown>;
}

export type PiNativeFrame =
    | { kind: 'hello'; version: number; token: string }
    | { kind: 'welcome'; version: number }
    | { kind: 'ready'; sessionId: string }
    | ({ kind: 'event' } & PiNativeEvent)
    | PiNativeRequest
    | { kind: 'response'; id: string; sessionId: string; success: boolean; data?: unknown; error?: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounds partial frames as well as complete frames. A malformed peer is disconnected. */
export class PiNativeFrameParser {
    private buffer = Buffer.alloc(0);

    feed(chunk: Buffer | string, onFrame: (frame: Record<string, unknown>) => void): void {
        this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        let end: number;
        while ((end = this.buffer.indexOf(10)) !== -1) {
            if (end > PI_NATIVE_MAX_FRAME_BYTES) throw new Error('Pi native IPC frame exceeds size limit');
            const line = this.buffer.subarray(0, end).toString('utf8');
            this.buffer = this.buffer.subarray(end + 1);
            const frame: unknown = JSON.parse(line);
            if (!isRecord(frame)) throw new Error('Invalid Pi native IPC frame');
            onFrame(frame);
        }
        if (this.buffer.length > PI_NATIVE_MAX_FRAME_BYTES) throw new Error('Pi native IPC frame exceeds size limit');
    }
}
