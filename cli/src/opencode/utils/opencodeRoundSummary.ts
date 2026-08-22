import type { FetchLike } from './opencodeCompactBridge';

export type OpencodeRoundSnapshot = {
    messageIds: string[];
};

export type OpencodeRoundModelUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
};

export type OpencodeRoundSummary = {
    usage: OpencodeRoundModelUsage;
    modelUsage: Record<string, OpencodeRoundModelUsage>;
    totalCostUsd?: number;
    numTurns: number;
    durationMs: number;
};

type OpencodeMessage = {
    info?: {
        id?: unknown;
        role?: unknown;
        providerID?: unknown;
        modelID?: unknown;
        tokens?: unknown;
        cost?: unknown;
    };
    parts?: unknown;
};

type RoundFetchOptions = {
    baseUrl: string;
    sessionId: string;
    signal: AbortSignal;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
};

const ROUND_FETCH_TIMEOUT_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function safeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function messageId(message: OpencodeMessage): string | null {
    return typeof message.info?.id === 'string' && message.info.id.length > 0 ? message.info.id : null;
}

function messageText(message: OpencodeMessage): string | null {
    if (!Array.isArray(message.parts)) return null;
    const text = message.parts
        .filter(isRecord)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    return text || null;
}

async function fetchMessages(options: RoundFetchOptions): Promise<OpencodeMessage[] | null> {
    const fetchFn = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal.aborted) return null;
    options.signal.addEventListener('abort', abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, options.timeoutMs ?? ROUND_FETCH_TIMEOUT_MS);
    });
    try {
        const request = (async (): Promise<OpencodeMessage[] | null> => {
            const response = await fetchFn(
                options.baseUrl + '/session/' + encodeURIComponent(options.sessionId) + '/message',
                { method: 'GET', signal: controller.signal }
            );
            if (!response.ok) return null;
            const parsed: unknown = await response.json();
            return Array.isArray(parsed) ? parsed as OpencodeMessage[] : null;
        })();
        return await Promise.race([request, timedOut]);
    } catch {
        return null;
    } finally {
        if (timeout) clearTimeout(timeout);
        options.signal.removeEventListener('abort', abort);
    }
}

/** Captures the persisted-message identity boundary immediately before a prompt. */
export async function captureOpencodeRoundSnapshot(options: RoundFetchOptions): Promise<OpencodeRoundSnapshot | null> {
    const messages = await fetchMessages(options);
    if (!messages) return null;
    const messageIds: string[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
        const id = messageId(message);
        if (!id || seen.has(id)) return null;
        seen.add(id);
        messageIds.push(id);
    }
    return { messageIds };
}

function parseAssistantUsage(message: OpencodeMessage): { key: string; usage: OpencodeRoundModelUsage; cost: number } | null {
    if (message.info?.role !== 'assistant') return null;
    const providerID = message.info.providerID;
    const modelID = message.info.modelID;
    const tokens = message.info.tokens;
    if (typeof providerID !== 'string' || providerID.length === 0 || typeof modelID !== 'string' || modelID.length === 0 || !isRecord(tokens)) return null;

    const cache = tokens.cache;
    if (!isRecord(cache)) return null;
    const inputTokens = safeInteger(tokens.input);
    const outputTokens = safeInteger(tokens.output);
    const reasoningTokens = safeInteger(tokens.reasoning);
    const cacheReadInputTokens = safeInteger(cache.read);
    const cacheCreationInputTokens = safeInteger(cache.write);
    const cost = finiteNonNegative(message.info.cost);
    if (inputTokens === null || outputTokens === null || reasoningTokens === null || cacheReadInputTokens === null || cacheCreationInputTokens === null || cost === null) return null;

    const displayOutputTokens = outputTokens + reasoningTokens;
    if (!Number.isSafeInteger(displayOutputTokens)) return null;

    return {
        key: providerID + '/' + modelID,
        usage: {
            inputTokens,
            outputTokens: displayOutputTokens,
            cacheReadInputTokens,
            cacheCreationInputTokens
        },
        cost
    };
}

function addUsage(total: OpencodeRoundModelUsage, next: OpencodeRoundModelUsage): boolean {
    total.inputTokens += next.inputTokens;
    total.outputTokens += next.outputTokens;
    total.cacheReadInputTokens += next.cacheReadInputTokens;
    total.cacheCreationInputTokens += next.cacheCreationInputTokens;
    return Object.values(total).every(Number.isSafeInteger);
}

/**
 * Loads the post-prompt message list and aggregates every new assistant row.
 * The prompt text anchors the original user row; assistant parent IDs are
 * deliberately ignored because auto-compaction creates synthetic parents.
 */
export async function fetchOpencodeRoundSummary(options: RoundFetchOptions & {
    promptText: string;
    snapshot: OpencodeRoundSnapshot;
    durationMs: number;
}): Promise<OpencodeRoundSummary | null> {
    if (finiteNonNegative(options.durationMs) === null) return null;
    const messages = await fetchMessages(options);
    if (!messages) return null;

    const before = new Set(options.snapshot.messageIds);
    if (before.size !== options.snapshot.messageIds.length) return null;
    const seen = new Set<string>();
    const delta: OpencodeMessage[] = [];
    for (const message of messages) {
        const id = messageId(message);
        if (!id || seen.has(id)) return null;
        seen.add(id);
        if (!before.has(id)) delta.push(message);
    }

    const hasOriginalPrompt = delta.some((message) => message.info?.role === 'user' && messageText(message) === options.promptText);
    if (!hasOriginalPrompt) return null;

    const usage: OpencodeRoundModelUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
    };
    const modelUsage = new Map<string, OpencodeRoundModelUsage>();
    let totalCostUsd = 0;
    let numTurns = 0;
    for (const message of delta) {
        if (message.info?.role !== 'assistant') continue;
        const parsed = parseAssistantUsage(message);
        if (!parsed) return null;
        let perModel = modelUsage.get(parsed.key);
        if (!perModel) {
            perModel = {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0
            };
            modelUsage.set(parsed.key, perModel);
        }
        if (!addUsage(perModel, parsed.usage) || !addUsage(usage, parsed.usage)) return null;
        totalCostUsd += parsed.cost;
        numTurns++;
    }
    if (numTurns === 0 || !Number.isSafeInteger(numTurns) || !Number.isFinite(totalCostUsd)) return null;

    return {
        usage,
        modelUsage: Object.fromEntries(modelUsage),
        ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
        numTurns,
        durationMs: options.durationMs
    };
}
