import { trimIdent } from "@/utils/trimIdent";
import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from "@hapi/protocol/sessionCitation";
import { isPeerToolsDisabled } from "@/modules/common/peerTools";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { withSessionJobInstruction } from "@/modules/common/sessionJobInstruction";
import { withSessionSummaryInstruction } from "@/modules/common/sessionSummaryInstruction";
import { buildTitleInstruction } from "@/modules/common/titleInstruction";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    ${buildTitleInstruction('mcp__hapi__change_title')}
    ${isPeerToolsDisabled() ? SESSION_CITATION_DISABLED_STEER : buildSessionCitationSteerInstruction({
        inspectTool: 'mcp__hapi__inspect_peer',
    })}
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
 * Resolve the Claude append-system-prompt text.
 * Co-Authored-By is read once from Claude settings; session-summary contract
 * is resolved at call time so hub toggle / env apply after session bootstrap.
 */
export function getSystemPrompt(): string {
    const includeCoAuthored = shouldIncludeCoAuthoredBy();
    const base = includeCoAuthored
        ? BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS
        : BASE_SYSTEM_PROMPT;
    return withSessionSummaryInstruction(withSessionJobInstruction(base));
}
