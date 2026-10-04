import { trimIdent } from "@/utils/trimIdent";
import { buildSessionCitationSteerInstruction } from "@hapi/protocol/sessionCitation";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { DISPLAY_IMAGE_PROMPT_CLAUDE, DISPLAY_MEDIA_PROMPT_CLAUDE, DISPLAY_VIDEO_PROMPT_CLAUDE } from "@/modules/common/displayImagePrompt";
import { withSessionSummaryInstruction } from "@/modules/common/sessionSummaryInstruction";
import { buildPerTurnTitleParagraph, isAutoTitlePerTurnEnabled } from "@/modules/common/titleInstruction";

/**
 * Stock (per-turn mode off) title steer, kept verbatim so off-mode prompts
 * stay byte-identical to the pre-toggle constant.
 */
const TITLE_SPARING_LINE =
    'Use the title tool sparingly. For a new chat, call the tool "mcp__hapi__change_title" once after the user\'s initial request is clear, and set a concise task title. Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording. Rename only when the user\'s primary objective changes substantially and the existing title would be misleading.';

/**
 * Base system prompt shared across all configurations
 */
function buildBaseSystemPrompt(env: NodeJS.ProcessEnv): string {
    const titleSteer = isAutoTitlePerTurnEnabled(env)
        ? buildPerTurnTitleParagraph('mcp__hapi__change_title')
        : TITLE_SPARING_LINE;
    return trimIdent(`
    ${titleSteer}
    ${DISPLAY_IMAGE_PROMPT_CLAUDE}
    ${DISPLAY_VIDEO_PROMPT_CLAUDE}
    ${DISPLAY_MEDIA_PROMPT_CLAUDE}
    ${buildSessionCitationSteerInstruction({
        inspectTool: 'mcp__hapi__inspect_peer',
        pingTool: 'mcp__hapi__ping_peer',
        listPeersTool: 'mcp__hapi__list_peers',
    })}
`);
}

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
 * Resolve the Claude append-system-prompt text.
 * Co-Authored-By is read once from Claude settings; session-summary contract
 * and the per-turn title steer are resolved at call time so hub toggles /
 * env apply after session bootstrap.
 */
export function getSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
    const includeCoAuthored = shouldIncludeCoAuthoredBy();
    const base = includeCoAuthored
        ? buildBaseSystemPrompt(env) + '\n\n' + CO_AUTHORED_CREDITS
        : buildBaseSystemPrompt(env);
    return withSessionSummaryInstruction(base, env);
}
