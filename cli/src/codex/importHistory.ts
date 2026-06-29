import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ApiSessionClient } from '@/lib';
import { findCodexSessionFile, findCodexSessionTitle, formatCodexSessionTitle } from '@/modules/common/codexSessions';
import { logger } from '@/ui/logger';
import { convertCodexEvent, type CodexSessionEvent } from './utils/codexEventConverter';
import { normalizeCodexUsage } from './utils/codexUsage';

function isSameOrChild(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

type TitleSource = 'index' | 'user' | 'agent';
type ImportSessionConfig = {
    model?: string;
    modelReasoningEffort?: string;
};
type ImportSessionClient = ApiSessionClient & {
    applySessionConfig?: (config: ImportSessionConfig) => void;
};

function parseCodexSessionEvent(line: string): CodexSessionEvent | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== 'string' || record.type.length === 0) {
        return null;
    }
    return {
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        type: record.type,
        payload: record.payload
    };
}

function extractSessionPath(lines: string[]): string | null {
    for (const line of lines.slice(0, 100)) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || typeof parsed !== 'object') continue;
        const record = parsed as Record<string, unknown>;
        if (record.type === 'session_meta') {
            const payload = record.payload && typeof record.payload === 'object'
                ? record.payload as Record<string, unknown>
                : null;
            const path = (typeof payload?.cwd === 'string' && payload.cwd) ||
                (typeof payload?.path === 'string' && payload.path) || null;
            if (path) return path;
        }
    }
    return null;
}

export async function importCodexSessionHistory(args: {
    session: ImportSessionClient;
    codexSessionId: string;
    expectedDirectory?: string;
}): Promise<{ imported: number; filePath: string | null; model?: string; modelReasoningEffort?: string }> {
    const filePath = await findCodexSessionFile(args.codexSessionId);
    if (!filePath) {
        logger.debug(`[codex-history-import] No transcript found for Codex session ${args.codexSessionId}`);
        return { imported: 0, filePath: null };
    }

    const content = await readFile(filePath, 'utf8');

    if (args.expectedDirectory) {
        const sessionPath = extractSessionPath(content.split('\n'));
        if (!sessionPath || !isSameOrChild(args.expectedDirectory, sessionPath)) {
            logger.warn(
                `[codex-history-import] Rejecting import: session path "${sessionPath ?? '(missing)'}" is outside expected directory "${args.expectedDirectory}"`
            );
            return { imported: 0, filePath: null };
        }
    }
    let imported = 0;
    let title = await findCodexSessionTitle(args.codexSessionId);
    let titleSource: TitleSource | null = title ? 'index' : null;
    let restoredModel: string | undefined;
    let restoredModelReasoningEffort: string | undefined;
    for (const line of content.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const event = parseCodexSessionEvent(line);
        if (!event) {
            continue;
        }
        const converted = convertCodexEvent(event);
        if (converted?.sessionId) {
            const payload = event.payload && typeof event.payload === 'object'
                ? event.payload as Record<string, unknown>
                : null;
            if (typeof payload?.model === 'string' && payload.model.length > 0) {
                restoredModel = payload.model;
            }
            const sessionReasoningEffort = payload?.model_reasoning_effort ?? payload?.modelReasoningEffort ?? payload?.reasoning_effort ?? payload?.reasoningEffort;
            if (typeof sessionReasoningEffort === 'string' && sessionReasoningEffort.length > 0) {
                restoredModelReasoningEffort = sessionReasoningEffort;
            }
            args.session.updateMetadata((metadata) => ({
                ...metadata,
                codexSessionId: converted.sessionId
            }));
        }
        if (event.type === 'event_msg' && event.payload && typeof event.payload === 'object') {
            const payload = event.payload as Record<string, unknown>;
            if (payload.type === 'turn_context') {
                if (typeof payload.model === 'string' && payload.model.length > 0) {
                    restoredModel = payload.model;
                }
                const reasoningEffort = payload.reasoning_effort ?? payload.reasoningEffort ?? payload.model_reasoning_effort ?? payload.modelReasoningEffort;
                if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
                    restoredModelReasoningEffort = reasoningEffort;
                }
            }
        }
        if (converted?.userMessage) {
            const userTitle = formatCodexSessionTitle(converted.userMessage);
            if (userTitle && titleSource !== 'index' && titleSource !== 'user') {
                title = userTitle;
                titleSource = 'user';
            }
            args.session.sendUserMessage(converted.userMessage);
            imported += 1;
        }
        if (converted?.message) {
            if (converted.message.type === 'token_count') {
                const codexUsage = normalizeCodexUsage(converted.message);
                if (codexUsage) {
                    args.session.updateMetadata((metadata) => ({
                        ...metadata,
                        codexUsage
                    }));
                }
            }
            if (converted.message.type === 'message' && !title) {
                title = formatCodexSessionTitle(converted.message.message);
                titleSource = 'agent';
            }
            args.session.sendAgentMessage(converted.message);
            imported += 1;
        }
    }

    if (title) {
        args.session.updateMetadata((metadata) => ({
            ...metadata,
            summary: {
                text: title,
                updatedAt: Date.now()
            }
        }));
    }

    const restoredConfig: ImportSessionConfig = {
        ...(restoredModel ? { model: restoredModel } : {}),
        ...(restoredModelReasoningEffort ? { modelReasoningEffort: restoredModelReasoningEffort } : {})
    };
    if (restoredConfig.model || restoredConfig.modelReasoningEffort) {
        args.session.applySessionConfig?.(restoredConfig);
    }

    logger.debug(`[codex-history-import] Imported ${imported} messages from ${filePath}`);
    return {
        imported,
        filePath,
        ...restoredConfig
    };
}
