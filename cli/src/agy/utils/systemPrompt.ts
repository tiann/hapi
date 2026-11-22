import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from '@hapi/protocol/sessionCitation';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction';
import { withSessionJobInstruction } from '@/modules/common/sessionJobInstruction';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';

/**
 * Builds durable HAPI session guidance injected via Antigravity ACP's
 * `_meta.antigravity.systemPrompt.append` channel rather than prepending to
 * user messages.
 */
export function getAgySystemPromptAppend(env: NodeJS.ProcessEnv = process.env): string {
    const peerInstruction = isPeerToolsDisabled(env)
        ? SESSION_CITATION_DISABLED_STEER
        : buildSessionCitationSteerInstruction({
            inspectTool: 'inspect_peer',
            pingTool: 'ping_peer',
            listPeersTool: 'list_peers',
            spawnTool: 'spawn_peer'
        });

    const base = trimIdent(`
        ## HAPI Session Tools
        For a new chat, call the "change_title" tool (on the "hapi" MCP server) once after the user's initial request is clear to set a concise task title. Do not rename for routine progress or substeps.
        ${peerInstruction}
        ${SKILL_LOOKUP_INSTRUCTION}
    `);

    return withSessionSummaryInstruction(withSessionJobInstruction(base), env);
}
