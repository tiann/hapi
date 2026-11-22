import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgySwarmBoardCommand {
    channel?: string;
}

interface RawSwarmMember {
    conversation_id?: string;
    role?: string;
    desired_state?: string;
    desired_model?: string;
    applied_model?: string;
    model?: string;
    workspace_mode?: string;
    phase?: string;
    killed?: boolean;
    channels?: string[];
}

interface RawSwarmRoster {
    title?: string;
    members?: Record<string, RawSwarmMember>;
}

interface RawSwarmBoardPost {
    seq?: number;
    agent?: string;
    text?: string;
    time?: string;
    kind?: string;
    channel?: string;
}

const MAX_DISPLAYED_BOARD_POSTS = 50;

function isSafeSessionSegment(sessionId: string): boolean {
    return sessionId.length > 0
        && !sessionId.includes('/')
        && !sessionId.includes('\\')
        && !sessionId.includes('..')
        && !sessionId.includes('\0');
}

/**
 * Matches `/swarm board` and `/swarm board --channel <name>` (or `/swarm board #<name>`),
 * which `agy`'s swarm tool instructs the user to run to inspect the live board.
 * Task prompts like `/swarm refactor the parser` return `null` so they are
 * forwarded to `agy acp` for native `/swarm` skill expansion.
 */
export function parseAgySwarmBoardCommand(message: string): AgySwarmBoardCommand | null {
    const trimmed = message.trim();
    const match = /^\/swarm\s+board(?:\s+(?:--channel(?:=|\s+)|#)([a-zA-Z0-9_-]+))?\s*$/i.exec(trimmed);
    if (!match) return null;
    const channel = match[1]?.trim();
    return channel ? { channel } : {};
}

function formatMemberState(member: RawSwarmMember): string {
    if (member.killed === true) return 'killed';
    const phase = (member.phase ?? member.desired_state ?? '').trim().toUpperCase();
    switch (phase) {
        case 'WAITING':
            return 'waiting';
        case 'RUNNING':
        case 'WORKING':
            return 'working';
        case 'STOPPED':
            return 'stopped';
        case 'KILLED':
            return 'killed';
        default:
            return phase ? phase.toLowerCase() : 'waiting';
    }
}

function escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function readBoardPosts(filePath: string): RawSwarmBoardPost[] {
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const posts: RawSwarmBoardPost[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as RawSwarmBoardPost;
            if (parsed && typeof parsed === 'object') {
                posts.push(parsed);
            }
        } catch {
            // Skip malformed JSONL lines.
        }
    }
    return posts;
}

/**
 * Formats a Markdown snapshot of the native `agy` swarm roster and message
 * board stored under `<brainDir>/<sessionId>/.system_generated/swarm/`.
 */
export function formatAgySwarmBoard(
    brainDir: string,
    sessionId: string | null,
    options: AgySwarmBoardCommand = {}
): string {
    if (!sessionId || !isSafeSessionSegment(sessionId)) {
        return 'No active swarm board for this session yet. Start one with `/swarm <task>`.';
    }

    const swarmDir = join(brainDir, sessionId, '.system_generated', 'swarm');
    const roster = readJsonFile<RawSwarmRoster>(join(swarmDir, 'members.json'));
    const allPosts = readBoardPosts(join(swarmDir, 'board.jsonl'));

    const memberEntries = Object.entries(roster?.members ?? {});
    if (memberEntries.length === 0 && allPosts.length === 0) {
        return 'No active swarm board for this session yet. Start one with `/swarm <task>`.';
    }

    const lines: string[] = [];
    const title = roster?.title?.trim();
    const channelFilter = options.channel?.trim();
    const headerSuffix = [
        title ? `— ${title}` : null,
        channelFilter ? `(#${channelFilter})` : null
    ].filter(Boolean).join(' ');
    lines.push(headerSuffix ? `### Swarm Board ${headerSuffix}` : '### Swarm Board');

    if (memberEntries.length > 0) {
        lines.push('');
        lines.push('| Member | Role | State | Model | Workspace |');
        lines.push('| :--- | :--- | :--- | :--- | :--- |');
        const sortedMembers = [...memberEntries].sort(([a], [b]) => {
            if (a === 'coordinator') return -1;
            if (b === 'coordinator') return 1;
            return a.localeCompare(b);
        });
        for (const [name, member] of sortedMembers) {
            const role = escapeMarkdownTableCell(member.role ?? (name === 'coordinator' ? 'coordinator' : 'worker'));
            const state = escapeMarkdownTableCell(formatMemberState(member));
            const model = escapeMarkdownTableCell(member.applied_model ?? member.model ?? member.desired_model ?? 'default');
            const workspace = escapeMarkdownTableCell(member.workspace_mode ?? 'inherit');
            lines.push(`| \`@${escapeMarkdownTableCell(name)}\` | ${role} | ${state} | \`${model}\` | ${workspace} |`);
        }
    }

    const filteredPosts = channelFilter
        ? allPosts.filter((post) => (post.channel ?? 'main') === channelFilter)
        : allPosts;

    lines.push('');
    lines.push(channelFilter ? `#### Board Messages (#${channelFilter})` : '#### Board Messages');
    if (filteredPosts.length === 0) {
        lines.push(channelFilter ? `_No messages in #${channelFilter} yet._` : '_No messages posted yet._');
        return lines.join('\n');
    }

    const omittedCount = Math.max(0, filteredPosts.length - MAX_DISPLAYED_BOARD_POSTS);
    if (omittedCount > 0) {
        lines.push(`_Showing latest ${MAX_DISPLAYED_BOARD_POSTS} of ${filteredPosts.length} messages (${omittedCount} earlier omitted)._`);
    }

    const visiblePosts = filteredPosts.slice(-MAX_DISPLAYED_BOARD_POSTS);
    for (const post of visiblePosts) {
        const seqLabel = typeof post.seq === 'number' ? `#${post.seq}` : '#?';
        const author = post.agent?.trim() || 'unknown';
        const channel = post.channel?.trim();
        const channelBadge = channel && channel !== 'main' && !channelFilter ? ` \`#${channel}\`` : '';
        const timeBadge = post.time?.trim() ? ` (${post.time.trim()})` : '';
        const text = (post.text ?? '').trim();
        lines.push(`- **${seqLabel}** \`@${author}\`${channelBadge}${timeBadge}: ${text}`);
    }

    return lines.join('\n');
}
