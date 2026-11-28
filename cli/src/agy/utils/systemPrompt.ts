import { buildSessionCitationSteerInstruction, SESSION_CITATION_DISABLED_STEER } from '@hapi/protocol/sessionCitation';
import type { HapiMcpToolName } from '@/claude/utils/startHappyServer';
import { isPeerToolsDisabled } from '@/modules/common/peerTools';
import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction';
import { withSessionJobInstruction } from '@/modules/common/sessionJobInstruction';
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction';

/**
 * Self-session HAPI MCP tools safe to expose on Antigravity runtimes that can
 * invoke ACP-supplied MCP tools in default mode without requesting permission.
 * Excludes cross-session peer tools (`list_peers`, `ping_peer`, `inspect_peer`,
 * `spawn_peer`), metadata/external-ref mutations (`link_pr`), and arbitrary
 * local media readers (`display_*`).
 */
export const AGY_SAFE_HAPI_MCP_TOOLS: readonly HapiMcpToolName[] = [
    'change_title',
    'session_job',
    'skill_lookup'
] as const;

const SESSION_CITATION_UNEXPOSED_STEER =
    'When the user cites another HAPI session as [title](/sessions/<id>), ' +
    'Copy-reference prose See session "…" (/sessions/<id>) for context, ' +
    'or a bare /sessions/<id>, extract that <id>. ' +
    '/sessions/<id> is a HAPI hub path, not a local filesystem path - do not Grep, Glob, or Read it as a file. ' +
    'Peer session MCP tools are not exposed in this Antigravity session; ' +
    'ask the user to paste the relevant context from that session instead.';

/**
 * Builds durable HAPI session guidance injected via Antigravity ACP's
 * `_meta.antigravity.systemPrompt.append` channel rather than prepending to
 * user messages, keeping guidance strictly scoped to `enabledTools`.
 */
export function getAgySystemPromptAppend(
    enabledTools: readonly HapiMcpToolName[] = AGY_SAFE_HAPI_MCP_TOOLS,
    env: NodeJS.ProcessEnv = process.env
): string {
    const toolSet = new Set<HapiMcpToolName>(enabledTools);
    const lines: string[] = ['## HAPI Session Tools'];

    if (toolSet.has('change_title')) {
        lines.push(
            'For a new chat, call the "change_title" tool (on the "hapi" MCP server) once after the user\'s initial request is clear to set a concise task title. Do not rename for routine progress or substeps.'
        );
    }

    if (isPeerToolsDisabled(env)) {
        lines.push(SESSION_CITATION_DISABLED_STEER);
    } else if (toolSet.has('inspect_peer') && toolSet.has('ping_peer')) {
        lines.push(buildSessionCitationSteerInstruction({ inspectTool: 'the "inspect_peer" tool (on the "hapi" MCP server)' }));
    } else {
        lines.push(SESSION_CITATION_UNEXPOSED_STEER);
    }

    if (toolSet.has('skill_lookup')) {
        lines.push(SKILL_LOOKUP_INSTRUCTION);
    }

    const base = lines.join('\n');
    const withJob = toolSet.has('session_job') ? withSessionJobInstruction(base) : base;
    return withSessionSummaryInstruction(withJob, env);
}
