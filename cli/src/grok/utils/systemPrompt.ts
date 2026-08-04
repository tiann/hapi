import { SKILL_LOOKUP_INSTRUCTION } from '@/modules/common/skillLookupInstruction'
import { withSessionSummaryInstruction } from '@/modules/common/sessionSummaryInstruction'

export const GROK_TITLE_INSTRUCTION =
    `Use the tool "hapi_change_title" once after the initial request is clear to set a concise session title. Do not rename for routine progress or substeps.\n${SKILL_LOOKUP_INSTRUCTION}`

export function getGrokTitleInstruction(env: NodeJS.ProcessEnv = process.env): string {
    return withSessionSummaryInstruction(GROK_TITLE_INSTRUCTION, env)
}
