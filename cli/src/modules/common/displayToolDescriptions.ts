/** Media delivery contracts belong to the tools, rather than every agent's prompt. */
const DELIVERY_SCOPE = 'Respect explicit delivery preferences; do not redisplay user-provided files unless requested.';

export const DISPLAY_IMAGE_TOOL_DESCRIPTION = 'Display a local image to the human user in the current HAPI chat. Use an absolute filesystem path (up to 25 MiB). This does not provide image input to the model and cannot be used to read, inspect, or analyze image contents. ' + DELIVERY_SCOPE;

export const DISPLAY_VIDEO_TOOL_DESCRIPTION = 'Display a local MP4 or WebM video inline in the current HAPI chat. Use an absolute filesystem path (up to 25 MiB). ' + DELIVERY_SCOPE;

export const DISPLAY_MEDIA_TOOL_DESCRIPTION = 'Send a local file to the user in the current HAPI chat. Use an absolute filesystem path (up to 25 MiB). Recognized images, video, and audio are shown inline; other files use a download card. ' + DELIVERY_SCOPE;

/** Pi returns an image block to both the chat and model, unlike the MCP tools. */
export const PI_DISPLAY_IMAGE_TOOL_DESCRIPTION = 'Use hapi_display_image to show a local PNG, JPEG, GIF, or WebP to the user in the HAPI chat. Use an absolute filesystem path (up to 25 MiB). The image also enters the model context; use a file-reading tool for analysis. ' + DELIVERY_SCOPE;
