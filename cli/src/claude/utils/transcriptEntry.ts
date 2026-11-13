import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { logger } from '@/ui/logger'
import { getClaudeProjectsDir } from './path'
import { isClaudeChatVisibleMessage } from './chatVisibility'
import type { RawJSONLines } from '../types'

/**
 * XML tags that Claude Code injects as `type:'user'` messages.
 * These are internal bookkeeping, not text the human actually typed.
 */
const SYSTEM_INJECTION_PREFIXES = [
    '<task-notification>',
    '<command-name>',
    '<local-command-caveat>',
    '<system-reminder>',
]

export function extractRawUserTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return content
    }

    if (!Array.isArray(content)) {
        return null
    }

    const parts = content
        .map((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return null
            const record = block as Record<string, unknown>
            return record.type === 'text' && typeof record.text === 'string'
                ? record.text
                : null
        })
        .filter((text): text is string => text !== null)

    return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Returns true if a JSONL message should be classified as a user-role message
 * (i.e., text typed by a real human) rather than an agent-role message.
 *
 * Claude Code injects system messages (task notifications, command caveats, …)
 * into the JSONL log as `type:'user'` entries so the model sees them in
 * context.  All metadata fields (`userType`, `isMeta`, …) are identical to
 * genuine user messages, so the only reliable signal is the message content
 * itself: injected messages always start with a well-known XML tag.
 */
export function isExternalUserMessage(body: RawJSONLines): body is Extract<RawJSONLines, { type: 'user' }> {
    if (body.type !== 'user') return false
    // Defensive: a malformed/minimal user line may lack `.message`. Treat it as
    // a non-external (forwardable) message rather than throwing.
    const message = (body as { message?: { content?: unknown } }).message
    if (!message || typeof message !== 'object') return false
    const text = extractRawUserTextContent(message.content)
    if (text === null) return false
    if (body.isSidechain === true) return false
    if (body.isMeta === true) return false

    const trimmed = text.trimStart()
    for (const prefix of SYSTEM_INJECTION_PREFIXES) {
        if (trimmed.startsWith(prefix)) return false
    }
    return true
}

/**
 * Transcript entry filter used when relaying Claude Code transcript entries
 * into the web UI: internal meta messages (e.g. skill injections), compact
 * summaries, and invisible system messages (e.g. init, stop_hook_summary)
 * must not appear in the chat.
 */
export function isImportableClaudeEntry(message: RawJSONLines): boolean {
    if (message.isMeta || message.isCompactSummary) {
        return false
    }
    return isClaudeChatVisibleMessage(message)
}

async function isFile(filePath: string): Promise<boolean> {
    return stat(filePath).then((s) => s.isFile(), () => false);
}

/**
 * Resolve a session's transcript file. Claude Code moves the transcript to the
 * project dir of the new cwd when the session enters or leaves a git worktree,
 * so look for it by session id across all project dirs once the known path is
 * gone.
 *
 * `sessionFiles` is the caller's session id → transcript path cache; it is
 * updated in place when the transcript has moved. `onFileMoved` lets the
 * caller react to a move (e.g. re-read from the top and re-point watchers).
 */
export async function findClaudeSessionFile(
    sessionId: string,
    opts: {
        projectDir: string;
        sessionFiles: Map<string, string>;
        onFileMoved?: (newPath: string, knownPath: string) => void;
    }
): Promise<string> {
    const known = opts.sessionFiles.get(sessionId) ?? join(opts.projectDir, `${sessionId}.jsonl`);
    if (await isFile(known)) {
        return known;
    }
    const projectsDir = getClaudeProjectsDir();
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const dir of await readdir(projectsDir).catch(() => [])) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
        const mtimeMs = await stat(candidate).then((s) => s.mtimeMs, () => null);
        if (mtimeMs !== null && (!newest || mtimeMs > newest.mtimeMs)) {
            newest = { path: candidate, mtimeMs };
        }
    }
    if (!newest || newest.path === known) {
        return known;
    }
    logger.debug(`[SESSION_SCANNER] Session ${sessionId} transcript moved to ${newest.path}`);
    opts.sessionFiles.set(sessionId, newest.path);
    // Re-read the moved file from the top; processed event keys drop what was already sent.
    opts.onFileMoved?.(newest.path, known);
    return newest.path;
}

/**
 * Claude Code 2.x writes each subagent to <session>/subagents/agent-*.jsonl
 * instead of the main session log.
 */
export async function listClaudeSubagentFiles(sessionFile: string): Promise<string[]> {
    const dir = join(sessionFile.slice(0, -'.jsonl'.length), 'subagents');
    try {
        // Deterministic name order: the OS directory order is not stable and
        // would reshuffle assembled transcripts between imports. Chronology
        // comes from the entries' timestamps at assembly time.
        return (await readdir(dir))
            .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
            .sort()
            .map((name) => join(dir, name));
    } catch {
        return [];
    }
}

/**
 * The transcript lines carry no parent tool_use id; the sibling meta.json
 * records it as `toolUseId`. Without it the web tracer can only fall back
 * to matching the subagent prompt against the Agent tool input.
 *
 * `cache` is the caller's subagent transcript path → parent tool_use id cache,
 * populated on first successful read.
 */
export async function readSubagentParentToolUseId(filePath: string, cache?: Map<string, string>): Promise<string | undefined> {
    const cached = cache?.get(filePath);
    if (cached) {
        return cached;
    }
    try {
        const meta = JSON.parse(await readFile(filePath.slice(0, -'.jsonl'.length) + '.meta.json', 'utf-8'));
        if (typeof meta?.toolUseId === 'string') {
            cache?.set(filePath, meta.toolUseId);
            return meta.toolUseId;
        }
    } catch {
        // meta.json not written yet
    }
    return undefined;
}
