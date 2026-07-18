import { trimIdent } from '@/utils/trimIdent';

/**
 * Unified chat-title instruction, shared by all agent families.
 *
 * preferred = change_title tool name in THIS runtime's MCP namespace
 * (Claude: mcp__hapi__change_title; Codex: functions.hapi__change_title;
 * OpenCode: hapi_change_title). Alias fallback covers the rest.
 * Antigravity agy cannot call HAPI MCP tools in print mode, so it uses an
 * adapter-owned title marker prompt instead of this helper.
 */
export function buildTitleInstruction(preferred: string): string {
    return trimIdent(`
        ALWAYS set and keep this chat's title via the title tool. Prefer calling ${preferred}. If that exact tool name is unavailable, call an equivalent alias such as mcp__hapi__change_title, functions.hapi__change_title, hapi__change_title, or hapi_change_title.

        Title format: "<main event> · <current stage>". The " · <current stage>" suffix is optional.
        - Main event (prefix): what this whole chat is fundamentally about. Set it as soon as the task is clear (by your first reply), then keep it stable. Change the prefix only to fit the overall main event better — when it becomes clearer, can be more specific, or genuinely shifts — never for stage progress or mere rewording.
        - Current stage (suffix): the latest sub-task or phase. Replace it when the stage materially changes (do not append a trail); omit it for short single-stage chats.

        Keep titles short and specific: name the concrete feature, file, or goal — never generic words like "Chat", "Help", or "Task". Lead with the distinguishing word, use no trailing punctuation, and write the title in the user's language. A clear title keeps the chat easy to find later.
    `);
}
