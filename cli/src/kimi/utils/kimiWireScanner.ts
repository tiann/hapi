import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { BaseSessionScanner, type SessionFileScanResult, type SessionFileScanStats } from '@/modules/common/session/BaseSessionScanner';
import { logger } from '@/ui/logger';
import type { CodexMessage } from '@/agent/messageConverter';

/**
 * One line of a kimi-code `wire.jsonl` journal: `{ type, ...payload, time }`.
 * See `packages/agent-core-v2/src/wire/record.ts` (`opToWireRecord`) in
 * MoonshotAI/kimi-code — payload fields are flattened onto the record.
 */
export type KimiWireEvent = {
    type: string;
    time?: number;
    [key: string]: unknown;
};

export type KimiWireConversion = {
    userMessage?: string;
    message?: CodexMessage;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractInputText(input: unknown): string | null {
    if (!Array.isArray(input)) {
        return null;
    }
    const parts: string[] = [];
    for (const block of input) {
        const record = asRecord(block);
        if (record?.type === 'text') {
            const text = asString(record.text);
            if (text) {
                parts.push(text);
            }
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Converts a kimi-code wire journal event into hapi's codex-family message
 * shapes (same wire contract the hub and web already render for ACP agents).
 *
 * Mapped events (observed on wire protocol 1.4, kimi-code 0.26):
 *   turn.prompt / turn.steer (origin.kind = 'user') → user message
 *   context.append_loop_event/content.part (text)   → assistant message
 *   context.append_loop_event/content.part (think)  → reasoning
 *   context.append_loop_event/tool.call             → tool-call
 *   context.append_loop_event/tool.result           → tool-call-result
 *   context.append_loop_event/step.end              → token_count
 * Everything else (metadata, config.update, llm.request, usage.record,
 * step.begin, plan_mode.*, …) is ignored.
 */
export function convertKimiWireEvent(event: KimiWireEvent): KimiWireConversion | null {
    if (event.type === 'turn.prompt' || event.type === 'turn.steer') {
        const origin = asRecord(event.origin);
        if (asString(origin?.kind) !== 'user') {
            return null;
        }
        const text = extractInputText(event.input);
        return text ? { userMessage: text } : null;
    }

    if (event.type !== 'context.append_loop_event') {
        return null;
    }

    const loopEvent = asRecord(event.event);
    const loopType = asString(loopEvent?.type);
    if (!loopEvent || !loopType) {
        return null;
    }

    if (loopType === 'content.part') {
        const part = asRecord(loopEvent.part);
        const partType = asString(part?.type);
        if (partType === 'text') {
            const text = asString(part?.text);
            return text
                ? { message: { type: 'message', message: text } }
                : null;
        }
        if (partType === 'think') {
            const think = asString(part?.think);
            return think
                ? { message: { type: 'reasoning', message: think, id: asString(loopEvent.uuid) ?? randomUUID() } }
                : null;
        }
        return null;
    }

    if (loopType === 'tool.call') {
        const name = asString(loopEvent.name);
        const callId = asString(loopEvent.toolCallId) ?? asString(loopEvent.uuid);
        if (!name || !callId) {
            return null;
        }
        return {
            message: {
                type: 'tool-call',
                name,
                callId,
                input: loopEvent.args ?? null
            }
        };
    }

    if (loopType === 'tool.result') {
        const callId = asString(loopEvent.toolCallId) ?? asString(loopEvent.parentUuid);
        if (!callId) {
            return null;
        }
        const result = asRecord(loopEvent.result);
        return {
            message: {
                type: 'tool-call-result',
                callId,
                output: result ? (result.output ?? null) : null,
                // kimi-code wire: result.isError === true marks a failed tool
                ...(result?.isError === true ? { is_error: true } : {})
            }
        };
    }

    if (loopType === 'step.end') {
        const usage = asRecord(loopEvent.usage);
        if (!usage) {
            return null;
        }
        // kimi-code splits input into uncached (`inputOther`) and cached
        // portions; hapi's inputTokens contract expects the full input total.
        const inputOther = asFiniteNumber(usage.inputOther) ?? 0;
        const cacheRead = asFiniteNumber(usage.inputCacheRead) ?? 0;
        const cacheCreation = asFiniteNumber(usage.inputCacheCreation) ?? 0;
        return {
            message: {
                type: 'token_count',
                info: {
                    total: {
                        inputTokens: inputOther + cacheRead + cacheCreation,
                        outputTokens: asFiniteNumber(usage.output) ?? 0,
                        cachedInputTokens: cacheRead
                    }
                }
            }
        };
    }

    return null;
}

interface KimiWireScannerOptions {
    wirePath: string;
    onEvent: (event: KimiWireEvent) => void;
}

export interface KimiWireScanner {
    cleanup: () => Promise<void>;
}

export async function createKimiWireScanner(opts: KimiWireScannerOptions): Promise<KimiWireScanner> {
    const scanner = new KimiWireScannerImpl(opts);
    await scanner.start();
    return {
        cleanup: async () => {
            await scanner.cleanup();
        }
    };
}

class KimiWireScannerImpl extends BaseSessionScanner<KimiWireEvent> {
    private readonly wirePath: string;
    private readonly onEvent: (event: KimiWireEvent) => void;
    private fileEpoch = 0;
    private fileState: {
        device: number;
        inode: number;
        partialLine: Buffer;
        nextLineIndex: number;
    } | null = null;

    constructor(opts: KimiWireScannerOptions) {
        super({ intervalMs: 2000 });
        this.wirePath = opts.wirePath;
        this.onEvent = opts.onEvent;
    }

    protected async initialize(): Promise<void> {
        // Prime to EOF: only events written after hapi attaches are forwarded,
        // so reopening an existing session does not replay its whole history.
        const { events, nextCursor } = await this.readWire(0);
        const keys = events.map((entry) => this.generateEventKey(entry.event, {
            filePath: this.wirePath,
            lineIndex: entry.lineIndex
        }));
        this.seedProcessedKeys(keys);
        this.setCursor(this.wirePath, nextCursor);
    }

    protected async findSessionFiles(): Promise<string[]> {
        return [this.wirePath];
    }

    protected shouldWatchFile(filePath: string): boolean {
        return filePath === this.wirePath;
    }

    protected async parseSessionFile(_filePath: string, cursor: number): Promise<SessionFileScanResult<KimiWireEvent>> {
        return this.readWire(cursor);
    }

    protected generateEventKey(_event: KimiWireEvent, context: { filePath: string; lineIndex?: number }): string {
        return `${context.filePath}:${this.fileEpoch}:${context.lineIndex ?? -1}`;
    }

    protected async handleFileScan(stats: SessionFileScanStats<KimiWireEvent>): Promise<void> {
        for (const event of stats.events) {
            this.onEvent(event);
        }
        if (stats.newCount > 0) {
            logger.debug(`[kimi-wire-scanner] ${stats.newCount} new events from ${stats.filePath}`);
        }
    }

    private async readWire(startOffset: number): Promise<SessionFileScanResult<KimiWireEvent>> {
        let fileStats;
        try {
            fileStats = await stat(this.wirePath);
        } catch (error) {
            logger.debug(`[kimi-wire-scanner] Failed to stat wire file ${this.wirePath}: ${error}`);
            return { events: [], nextCursor: startOffset };
        }

        const previous = this.fileState;
        const identityChanged = Boolean(
            previous
            && (previous.device !== fileStats.dev || previous.inode !== fileStats.ino)
        );
        let effectiveStartOffset = startOffset;
        let partialLine = previous?.partialLine ?? Buffer.alloc(0);
        let nextLineIndex = previous?.nextLineIndex ?? 0;

        if (identityChanged || fileStats.size < effectiveStartOffset) {
            effectiveStartOffset = 0;
            partialLine = Buffer.alloc(0);
            nextLineIndex = 0;
            this.fileEpoch += 1;
        }

        const bytesToRead = fileStats.size - effectiveStartOffset;
        let appended: Buffer = Buffer.alloc(0);
        if (bytesToRead > 0) {
            try {
                appended = await readWireRange(this.wirePath, effectiveStartOffset, bytesToRead);
            } catch (error) {
                logger.debug(`[kimi-wire-scanner] Failed to read wire file ${this.wirePath}: ${error}`);
                return { events: [], nextCursor: startOffset };
            }
        }

        const content = partialLine.length > 0
            ? Buffer.concat([partialLine, appended])
            : appended;
        const events: { event: KimiWireEvent; lineIndex: number }[] = [];

        const parseLine = (lineBuffer: Buffer, lineIndex: number, allowIncomplete: boolean): boolean => {
            const line = lineBuffer.toString('utf-8');
            if (!line || line.trim().length === 0) return true;
            try {
                const parsed = JSON.parse(line) as KimiWireEvent;
                if (typeof parsed?.type === 'string' && parsed.type.length > 0) {
                    events.push({ event: parsed, lineIndex });
                }
                return true;
            } catch (error) {
                if (!allowIncomplete) {
                    logger.debug(`[kimi-wire-scanner] Failed to parse wire line ${this.wirePath}:${lineIndex + 1}: ${error}`);
                }
                return false;
            }
        };

        let lineStart = 0;
        for (let index = 0; index < content.length; index += 1) {
            if (content[index] !== 0x0a) continue;
            parseLine(content.subarray(lineStart, index), nextLineIndex, false);
            nextLineIndex += 1;
            lineStart = index + 1;
        }

        const trailing = content.subarray(lineStart);
        if (trailing.length > 0 && parseLine(trailing, nextLineIndex, true)) {
            partialLine = Buffer.alloc(0);
            nextLineIndex += 1;
        } else {
            partialLine = Buffer.from(trailing);
        }

        this.fileState = {
            device: fileStats.dev,
            inode: fileStats.ino,
            partialLine,
            nextLineIndex
        };

        return {
            events,
            nextCursor: effectiveStartOffset + appended.length
        };
    }
}

async function readWireRange(filePath: string, startOffset: number, length: number): Promise<Buffer> {
    const content = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    const handle = await open(filePath, 'r');
    try {
        while (bytesRead < length) {
            const result = await handle.read(content, bytesRead, length - bytesRead, startOffset + bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
    } finally {
        await handle.close();
    }
    return bytesRead === content.length ? content : content.subarray(0, bytesRead);
}
