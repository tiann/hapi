import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction'
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction'
import { buildPerTurnTitleParagraph, isAutoTitlePerTurnEnabled } from '@/modules/common/titleInstruction'

export const GROK_TITLE_INSTRUCTION =
    `Use the tool "hapi_change_title" once after the initial request is clear to set a concise session title. Do not rename for routine progress or substeps.\n${SKILL_LOOKUP_INSTRUCTION}`

export function getGrokTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    const base = isAutoTitlePerTurnEnabled(env)
        ? `${buildPerTurnTitleParagraph('hapi_change_title')}\n${SKILL_LOOKUP_INSTRUCTION}`
        : GROK_TITLE_INSTRUCTION
    return withSessionSummaryInstruction(base, env)
}
