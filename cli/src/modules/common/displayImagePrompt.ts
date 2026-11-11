import { trimIdent } from '@/utils/trimIdent';

/** Image delivery policy shared by MCP flavors and the separate Pi extension. */
export const IMAGE_DELIVERY_GUIDANCE = trimIdent(`
    When an image should be shown to the user, follow any explicit user or workspace preference for image delivery when supported and permitted. Without a stated preference, use the available HAPI image display tool.
    HAPI Web/PWA renders local Markdown images such as ![Description](images/result.png). The file must exist within the current session's configured working directory, be no larger than 10 MiB (10,485,760 bytes), and have a supported image extension and browser-decodable format. Prefer PNG, JPEG, GIF, or WebP for browser compatibility. Relative paths resolve from the session working directory; enclose paths containing spaces in angle brackets. Out-of-workspace paths and file:, data:, or blob: URLs are not supported.
    The native iOS and Android clients currently render conversation Markdown image references as placeholders, alternative text, or links rather than loading the images. Use the available image display tool for cross-client viewing, or when the viewing client is unknown and no delivery preference has been specified.
    When Markdown is unsuitable or a separate image card is requested, use the available image display tool with an absolute filesystem path. HAPI image display tools accept supported image content up to 25 MiB. Check the tool's own format and size requirements; it does not necessarily support every file Markdown cannot display.
    Normally show each image once. Do not deliver the same image through both Markdown and a display tool, or redisplay a user-provided image, unless requested. Do not switch delivery methods to bypass denied file access or tool approval.
`);

/**
 * Shared display_image MCP tool hints — one export per tool naming convention.
 * Inject into flavor system prompts and first-prompt bridge instructions.
 */
export const DISPLAY_IMAGE_PROMPT_CLAUDE = IMAGE_DELIVERY_GUIDANCE + '\n' + trimIdent(`
    When using the image display tool for the human user, call the tool "mcp__hapi__display_image" with the absolute filesystem path so HAPI can show it inline.
    This tool sends the image to the human user for inline display in HAPI. It is not an image-reading or image-understanding tool: it does not provide image input to the model and cannot be used to read, inspect, or analyze image contents.
`);

export const DISPLAY_IMAGE_PROMPT_CODEX = IMAGE_DELIVERY_GUIDANCE + '\n' + trimIdent(`
    When using the image display tool for the human user, call functions.hapi__display_image with the absolute filesystem path. If that exact tool name is unavailable, use an equivalent alias such as hapi__display_image, mcp__hapi__display_image, or hapi_display_image.
    This tool sends the image to the human user for inline display in HAPI. It is not an image-reading or image-understanding tool: it does not provide image input to the model and cannot be used to read, inspect, or analyze image contents.
`);

export const DISPLAY_VIDEO_PROMPT_CLAUDE = trimIdent(`
    When you create or find a local mp4 or webm recording the user should see, call the tool "mcp__hapi__display_video" with the file path so HAPI can show it inline.
`);

export const DISPLAY_VIDEO_PROMPT_CODEX = trimIdent(`
    When you create or find a local mp4 or webm file the user should see, call functions.hapi__display_video with the file path. If that exact tool name is unavailable, use an equivalent alias such as hapi__display_video, mcp__hapi__display_video, or hapi_display_video.
`);

export const DISPLAY_IMAGE_PROMPT_CURSOR = IMAGE_DELIVERY_GUIDANCE + '\n' + trimIdent(`
    When using the image display tool for the human user, call the tool "display_image" with the absolute filesystem path so HAPI can show it inline.
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
`) + '\n' + IMAGE_DELIVERY_GUIDANCE;
