import { trimIdent } from '@/utils/trimIdent';

/**
 * Shared display_image MCP tool hints — one export per tool naming convention.
 * Inject into flavor system prompts and first-prompt bridge instructions.
 */
export const DISPLAY_IMAGE_PROMPT_CLAUDE = trimIdent(`
    When you create or find a local image file that the human user should see, call the tool "mcp__hapi__display_image" with the absolute filesystem path so HAPI can show it inline.
    This tool sends the image to the human user for inline display in HAPI. It is not an image-reading or image-understanding tool: it does not provide image input to the model and cannot be used to read, inspect, or analyze image contents.
`);

export const DISPLAY_IMAGE_PROMPT_CODEX = trimIdent(`
    When you create or find a local image file that the human user should see, call functions.hapi__display_image with the absolute filesystem path. If that exact tool name is unavailable, use an equivalent alias such as hapi__display_image, mcp__hapi__display_image, or hapi_display_image.
    This tool sends the image to the human user for inline display in HAPI. It is not an image-reading or image-understanding tool: it does not provide image input to the model and cannot be used to read, inspect, or analyze image contents.
`);

export const DISPLAY_VIDEO_PROMPT_CLAUDE = trimIdent(`
    When you create or find a local mp4 or webm recording the user should see, call the tool "mcp__hapi__display_video" with the file path so HAPI can show it inline.
`);

export const DISPLAY_VIDEO_PROMPT_CODEX = trimIdent(`
    When you create or find a local mp4 or webm file the user should see, call functions.hapi__display_video with the file path. If that exact tool name is unavailable, use an equivalent alias such as hapi__display_video, mcp__hapi__display_video, or hapi_display_video.
`);

export const DISPLAY_IMAGE_PROMPT_CURSOR = trimIdent(`
    When you create or find a local image file that the human user should see, call the tool "display_image" with the absolute filesystem path so HAPI can show it inline.
    This tool sends the image to the human user for inline display in HAPI. It is not an image-reading or image-understanding tool: it does not provide image input to the model and cannot be used to read, inspect, or analyze image contents.
`);

export const DISPLAY_VIDEO_PROMPT_CURSOR = trimIdent(`
    When you create or find a local mp4 or webm recording the user should see, call the tool "display_video" with the absolute filesystem path so HAPI can show it inline.
`);

export const DISPLAY_MEDIA_PROMPT_CLAUDE = trimIdent(`
    When you create or find a local audio file or other non-image file that the user should receive, call the tool "mcp__hapi__display_media" with the file path so HAPI can show a player or download card.
`);

export const DISPLAY_MEDIA_PROMPT_CODEX = trimIdent(`
    When you create or find a local audio file or other non-image file that the user should receive, call functions.hapi__display_media with the file path. If that exact tool name is unavailable, use an equivalent alias such as hapi__display_media, mcp__hapi__display_media, or hapi_display_media.
`);

export const DISPLAY_MEDIA_PROMPT_CURSOR = trimIdent(`
    When you create or find a local audio file or other non-image file that the user should receive, call the tool "display_media" with the absolute filesystem path so HAPI can show a player or download card.
`);

/**
 * Display tool guidance for OpenCode, written once for all three tools. OpenCode v2 can expose
 * MCP tools only through a Code Mode catalog whose entries are callable as JavaScript inside the
 * `execute` tool, while other setups list them as direct tools; the wording covers both.
 */
export const DISPLAY_TOOLS_PROMPT_HAPI_MCP = trimIdent(`
    HAPI display tools (display_image, display_video, display_media) show a local file to the user in the HAPI chat.
    - Use them for files you created, or found on the user's behalf, that the user has not been shown. Files the user attached, pasted, or pointed you to are already visible to them, so do not display those again unless the user asks.
    - To call one: if hapi_<tool> is in your tool list, call it directly. Otherwise, if your Code Mode catalog lists tools.hapi.<tool>, call \`await tools.hapi.<tool>({ path })\` inside the \`execute\` tool. Do not guess other names.
    - display_image only shows the image to the user; it does not let you see or analyze it.
`);
