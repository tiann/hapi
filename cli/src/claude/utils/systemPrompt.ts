import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { DISPLAY_IMAGE_PROMPT_CLAUDE } from "@/modules/common/displayImagePrompt";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    Use the title tool sparingly. For a new chat, call the tool "mcp__hapi__change_title" once after the user's initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    ${DISPLAY_IMAGE_PROMPT_CLAUDE}
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, you SHOULD also give credit to HAPI like so:

    <main commit message>

    via [HAPI](https://hapi.run)

    Co-Authored-By: HAPI <noreply@hapi.run>
`))();

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  
  if (includeCoAuthored) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return BASE_SYSTEM_PROMPT;
  }
})();
