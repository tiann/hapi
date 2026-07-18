import { trimIdent } from "@/utils/trimIdent";
import { buildTitleInstruction } from "@/utils/titleInstruction";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = buildTitleInstruction('mcp__hapi__change_title');

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, you SHOULD also give credit to HAPI like so:

    <main commit message>

    via [HAPI](https://hapi.run)

    Co-Authored-By: HAPI <noreply@hapi.run>
`))();

export const TASK_NOTIFICATION_GUARD = (() => trimIdent(`
    Background task notifications:
    - <task-notification> means an internal background task notification, not a user request.
    - When woken by it, report only that task's completion, failure, or status.
    - Do not start new tasks, use tools, continue broader work, ask strategic follow-ups, or expand scope unless a later real user message asks.
    - Then wait for a real user message.
`))();

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  const basePrompt = BASE_SYSTEM_PROMPT + '\n\n' + TASK_NOTIFICATION_GUARD;
  
  if (includeCoAuthored) {
    return basePrompt + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return basePrompt;
  }
})();
