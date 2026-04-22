import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

type ResolveOptions = {
    codexHomeDir?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractNickname(payload: Record<string, unknown>): string | null {
    const direct = asNonEmptyString(payload.agent_nickname ?? payload.agentNickname ?? payload.nickname);
    if (direct) return direct;

    const source = asRecord(payload.source);
    const subagent = asRecord(source?.subagent);
    const threadSpawn = asRecord(subagent?.thread_spawn ?? subagent?.threadSpawn);
    return asNonEmptyString(threadSpawn?.agent_nickname ?? threadSpawn?.agentNickname ?? subagent?.agent_nickname);
}

async function findSessionFile(root: string, sessionId: string): Promise<string | null> {
    const suffix = `-${sessionId}.jsonl`;
    const stack = [root];

    while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;

        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(path);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith(suffix)) {
                return path;
            }
        }
    }

    return null;
}

export async function resolveCodexSubagentNickname(
    agentId: string,
    options: ResolveOptions = {}
): Promise<string | null> {
    if (agentId.length === 0) return null;

    const codexHomeDir = options.codexHomeDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const sessionFile = await findSessionFile(join(codexHomeDir, 'sessions'), agentId);
    if (!sessionFile) return null;

    let text: string;
    try {
        text = await readFile(sessionFile, 'utf8');
    } catch {
        return null;
    }

    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        const record = asRecord(event);
        if (record?.type !== 'session_meta') continue;

        const payload = asRecord(record.payload);
        if (!payload) return null;
        return extractNickname(payload);
    }

    return null;
}
