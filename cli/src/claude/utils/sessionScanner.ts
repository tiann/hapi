import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { basename, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { getProjectPath } from "./path";
import { BaseSessionScanner, SessionFileScanEntry, SessionFileScanResult, SessionFileScanStats } from "@/modules/common/session/BaseSessionScanner";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export async function createSessionScanner(opts: {
    sessionId: string | null;
    workingDirectory: string;
    onMessage: (message: RawJSONLines) => void;
    replayExistingMessages?: boolean;
}) {
    const scanner = new ClaudeSessionScanner({
        sessionId: opts.sessionId,
        workingDirectory: opts.workingDirectory,
        onMessage: opts.onMessage,
        replayExistingMessages: opts.replayExistingMessages
    });

    await scanner.start();

    return {
        cleanup: async () => {
            await scanner.cleanup();
        },
        onNewSession: (sessionId: string) => {
            scanner.onNewSession(sessionId);
        }
    };
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;

type ClaudeLinkedChild = {
    sessionId: string
    sidechainKey: string
}

class ClaudeSessionScanner extends BaseSessionScanner<RawJSONLines> {
    private readonly projectDir: string;
    private readonly onMessage: (message: RawJSONLines) => void;
    private readonly finishedSessions = new Set<string>();
    private readonly pendingSessions = new Set<string>();
    private currentSessionId: string | null;
    private readonly scannedSessions = new Set<string>();
    private readonly replayExistingMessages: boolean;
    private readonly linkedChildSessions = new Map<string, ClaudeLinkedChild>();
    private readonly sidechainKeyByPrompt = new Map<string, string>();
    private readonly knownEventKeys = new Set<string>();

    constructor(opts: {
        sessionId: string | null;
        workingDirectory: string;
        onMessage: (message: RawJSONLines) => void;
        replayExistingMessages?: boolean;
    }) {
        super({ intervalMs: 3000 });
        this.projectDir = getProjectPath(opts.workingDirectory);
        this.onMessage = opts.onMessage;
        this.currentSessionId = opts.sessionId;
        this.replayExistingMessages = opts.replayExistingMessages ?? false;
    }

    public onNewSession(sessionId: string): void {
        if (this.currentSessionId === sessionId) {
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
            return;
        }
        if (this.finishedSessions.has(sessionId)) {
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
            return;
        }
        if (this.pendingSessions.has(sessionId)) {
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
            return;
        }
        if (this.currentSessionId) {
            this.pendingSessions.add(this.currentSessionId);
        }
        logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`);
        this.currentSessionId = sessionId;
        this.invalidate();
    }

    protected async initialize(): Promise<void> {
        if (!this.currentSessionId || this.replayExistingMessages) {
            return;
        }
        const sessionFile = this.sessionFilePath(this.currentSessionId);
        const { events, totalLines } = await readSessionLog(sessionFile, 0);
        this.captureTaskSidechainCandidates(events.map((entry) => entry.event));
        logger.debug(`[SESSION_SCANNER] Marking ${events.length} existing messages as processed from session ${this.currentSessionId}`);
        const keys = events.map((entry) => this.generateEventKey(entry.event, {
            filePath: sessionFile,
            lineIndex: entry.lineIndex
        }));
        this.seedKnownProcessedKeys(keys);
        this.setCursor(sessionFile, totalLines);
    }

    protected async beforeScan(): Promise<void> {
        this.scannedSessions.clear();
    }

    protected async findSessionFiles(): Promise<string[]> {
        const files = new Set<string>();
        for (const sessionId of this.pendingSessions) {
            files.add(this.sessionFilePath(sessionId));
        }
        if (this.currentSessionId && !this.pendingSessions.has(this.currentSessionId)) {
            files.add(this.sessionFilePath(this.currentSessionId));
        }
        for (const linkedChild of this.linkedChildSessions.values()) {
            files.add(this.sessionFilePath(linkedChild.sessionId));
        }
        for (const watched of this.getWatchedFiles()) {
            files.add(watched);
        }
        return [...files];
    }

    protected async parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<RawJSONLines>> {
        const sessionId = sessionIdFromPath(filePath);
        if (sessionId) {
            this.scannedSessions.add(sessionId);
        }
        const { events, totalLines } = await readSessionLog(filePath, cursor);
        const linkedChild = sessionId ? this.linkedChildSessions.get(sessionId) : undefined;
        return {
            events: linkedChild
                ? events.map((entry) => ({
                    ...entry,
                    event: linkChildMessage(entry.event, linkedChild.sidechainKey)
                }))
                : events,
            nextCursor: totalLines
        };
    }

    protected generateEventKey(event: RawJSONLines, context: { filePath: string; lineIndex?: number }): string {
        const sessionId = sessionIdFromPath(context.filePath);
        const linkedChild = sessionId ? this.linkedChildSessions.get(sessionId) : undefined;
        return messageKey(event, linkedChild?.sidechainKey ?? null);
    }

    protected async handleFileScan(stats: SessionFileScanStats<RawJSONLines>): Promise<void> {
        this.captureTaskSidechainCandidates(stats.events);
        this.seedKnownProcessedKeys(stats.entries.map((entry) => this.generateEventKey(entry.event, {
            filePath: stats.filePath,
            lineIndex: entry.lineIndex
        })));
        for (const message of stats.events) {
            const id = message.type === 'summary' ? message.leafUuid : message.uuid;
            logger.debug(`[SESSION_SCANNER] Sending new message: type=${message.type}, uuid=${id}`);
            this.onMessage(message);
        }
        await this.linkChildSessionsFromPrompts();
        if (stats.parsedCount > 0) {
            const sessionId = sessionIdFromPath(stats.filePath) ?? 'unknown';
            logger.debug(`[SESSION_SCANNER] Session ${sessionId}: found=${stats.parsedCount}, skipped=${stats.skippedCount}, sent=${stats.newCount}`);
        }
    }

    protected async afterScan(): Promise<void> {
        for (const sessionId of this.scannedSessions) {
            if (this.pendingSessions.has(sessionId)) {
                this.pendingSessions.delete(sessionId);
                this.finishedSessions.add(sessionId);
            }
        }
    }

    private sessionFilePath(sessionId: string): string {
        return join(this.projectDir, `${sessionId}.jsonl`);
    }

    private seedKnownProcessedKeys(keys: Iterable<string>): void {
        for (const key of keys) {
            this.knownEventKeys.add(key);
        }
        this.seedProcessedKeys(keys);
    }

    private captureTaskSidechainCandidates(messages: RawJSONLines[]): void {
        for (const message of messages) {
            if (message.type !== 'assistant' || !message.message || !Array.isArray(message.message.content)) {
                continue;
            }

            for (const block of message.message.content) {
                if (!block || typeof block !== 'object') {
                    continue;
                }
                if (block.type !== 'tool_use' || block.name !== 'Task' || typeof block.id !== 'string') {
                    continue;
                }

                const prompt = extractPrompt(block.input);
                if (!prompt) {
                    continue;
                }

                this.sidechainKeyByPrompt.set(normalizePrompt(prompt), block.id);
            }
        }
    }

    private async linkChildSessionsFromPrompts(): Promise<void> {
        if (this.sidechainKeyByPrompt.size === 0) {
            return;
        }

        const projectEntries = await readdir(this.projectDir, { withFileTypes: true }).catch(() => []);
        for (const entry of projectEntries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }

            const childSessionId = entry.name.slice(0, -'.jsonl'.length);
            if (!childSessionId || childSessionId === this.currentSessionId) {
                continue;
            }
            if (this.pendingSessions.has(childSessionId) || this.finishedSessions.has(childSessionId)) {
                continue;
            }
            if (this.linkedChildSessions.has(childSessionId)) {
                continue;
            }

            const childFilePath = this.sessionFilePath(childSessionId);
            const { events, totalLines } = await readSessionLog(childFilePath, 0);
            const prompt = extractFirstUserPrompt(events.map((scanEntry) => scanEntry.event));
            if (!prompt) {
                continue;
            }

            const sidechainKey = this.sidechainKeyByPrompt.get(normalizePrompt(prompt));
            if (!sidechainKey) {
                continue;
            }

            const linkedChild: ClaudeLinkedChild = {
                sessionId: childSessionId,
                sidechainKey
            };
            this.linkedChildSessions.set(childSessionId, linkedChild);
            this.ensureWatcher(childFilePath);

            const decoratedEntries = events.map((scanEntry) => ({
                ...scanEntry,
                event: linkChildMessage(scanEntry.event, sidechainKey)
            }));

            const newMessages: RawJSONLines[] = [];
            const newKeys: string[] = [];
            for (const decoratedEntry of decoratedEntries) {
                const key = this.generateEventKey(decoratedEntry.event, {
                    filePath: childFilePath,
                    lineIndex: decoratedEntry.lineIndex
                });
                if (this.knownEventKeys.has(key)) {
                    continue;
                }
                this.knownEventKeys.add(key);
                newKeys.push(key);
                newMessages.push(decoratedEntry.event);
            }

            for (const message of newMessages) {
                const id = message.type === 'summary' ? message.leafUuid : message.uuid;
                logger.debug(`[SESSION_SCANNER] Sending linked child message: type=${message.type}, uuid=${id}, sidechain=${sidechainKey}`);
                this.onMessage(message);
            }

            this.seedProcessedKeys(newKeys);
            this.setCursor(childFilePath, totalLines);
        }
    }
}

//
// Helpers
//

function messageKey(message: RawJSONLines, linkedSidechainKey: string | null = null): string {
    const sidechainKey = linkedSidechainKey ?? extractSidechainKey(message);
    if (sidechainKey) {
        return `sidechain:${sidechainKey}:${stableStringify(sidechainMessageFingerprint(message))}`;
    }
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Read and parse session log file.
 * Returns only valid conversation messages, silently skipping internal events.
 */
async function readSessionLog(filePath: string, startLine: number): Promise<{ events: SessionFileScanEntry<RawJSONLines>[]; totalLines: number }> {
    logger.debug(`[SESSION_SCANNER] Reading session file: ${filePath}`);
    let file: string;
    try {
        file = await readFile(filePath, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${filePath}`);
        return { events: [], totalLines: startLine };
    }
    const lines = file.split('\n');
    const hasTrailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    const totalLines = hasTrailingEmpty ? lines.length - 1 : lines.length;
    let effectiveStartLine = startLine;
    if (effectiveStartLine > totalLines) {
        effectiveStartLine = 0;
    }
    const messages: SessionFileScanEntry<RawJSONLines>[] = [];
    for (let index = effectiveStartLine; index < lines.length; index += 1) {
        const l = lines[index];
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped.
                continue;
            }
            messages.push({ event: parsed.data, lineIndex: index });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return { events: messages, totalLines };
}

function sessionIdFromPath(filePath: string): string | null {
    const base = basename(filePath);
    if (!base.endsWith('.jsonl')) {
        return null;
    }
    return base.slice(0, -'.jsonl'.length);
}

function extractPrompt(input: unknown): string | null {
    if (typeof input === 'string') {
        return input;
    }
    if (!input || typeof input !== 'object') {
        return null;
    }

    const record = input as Record<string, unknown>;
    for (const key of ['prompt', 'title', 'message', 'text', 'content'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

function extractFirstUserPrompt(messages: RawJSONLines[]): string | null {
    for (const message of messages) {
        if (message.type !== 'user') {
            continue;
        }

        const content = message.message.content;
        if (typeof content === 'string' && content.length > 0) {
            return content;
        }

        if (!Array.isArray(content)) {
            continue;
        }

        const textBlocks = content
            .map((block) => block && typeof block === 'object' && 'type' in block && block.type === 'text' && typeof block.text === 'string'
                ? block.text
                : null)
            .filter((value): value is string => value !== null);

        if (textBlocks.length > 0) {
            return textBlocks.join(' ');
        }
    }

    return null;
}

function normalizePrompt(prompt: string): string {
    return prompt.trim().replace(/\s+/g, ' ');
}

function linkChildMessage(message: RawJSONLines, sidechainKey: string): RawJSONLines {
    return {
        ...message,
        isSidechain: true,
        meta: {
            ...(message.meta ?? {}),
            subagent: {
                kind: 'message',
                sidechainKey
            }
        }
    };
}

function extractSidechainKey(message: RawJSONLines): string | null {
    const subagent = message.meta?.subagent;
    if (!subagent) {
        return null;
    }
    if (Array.isArray(subagent)) {
        for (const item of subagent) {
            if (item && typeof item === 'object' && typeof (item as { sidechainKey?: unknown }).sidechainKey === 'string') {
                return (item as { sidechainKey: string }).sidechainKey;
            }
        }
        return null;
    }
    if (typeof subagent === 'object' && typeof (subagent as { sidechainKey?: unknown }).sidechainKey === 'string') {
        return (subagent as { sidechainKey: string }).sidechainKey;
    }
    return null;
}

function sidechainMessageFingerprint(message: RawJSONLines): Record<string, unknown> {
    if (message.type === 'summary') {
        return {
            type: message.type,
            summary: message.summary,
            leafUuid: message.leafUuid
        };
    }

    if (message.type === 'system') {
        return {
            type: message.type,
            subtype: message.subtype,
            isMeta: message.isMeta === true,
            error: message.error ?? null,
            meta: message.meta?.subagent ?? null
        };
    }

    return {
        type: message.type,
        content: message.message.content,
        toolUseResult: message.type === 'user' ? message.toolUseResult ?? null : null
    };
}

function stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
        return JSON.stringify(value);
    }
    if (typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
