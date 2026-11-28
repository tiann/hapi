import { trimIdent } from '@/utils/trimIdent';
import { buildTitleInstruction } from './titleInstruction';

/** Shell fallback for `hapi doctor inline-media` only — not injected into agent prompts. */
export const INLINE_MEDIA_SHELL_FALLBACK = trimIdent(`
    If display_image / display_video / display_media tools are not in your tool list, inline media via shell from the HAPI repo (needs bun + @modelcontextprotocol/sdk):
    cd <hapi-repo-root> && bun scripts/tooling/hapi-display-image.mjs <HAPI-session-id-prefix> <absolute-file-path> "title"
    Use the HAPI session uuid prefix from the web URL /sessions/<uuid> (first 8 chars), not cursorSessionId or other agent-native ids.
    Run hapi doctor inline-media to list active bridges and copy the exact command.
`);

/**
 * Title instructions for OpenCode first-prompt /
 * hapi-instructions.md. Cursor uses native MCP overlay + tool descriptions instead
 * (no user-turn prepend — that path was prompt-taint).
 */
export const HAPI_MCP_BRIDGE_PROMPT = buildTitleInstruction('hapi_change_title');
