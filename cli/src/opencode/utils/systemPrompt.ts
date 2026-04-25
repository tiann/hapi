import { trimIdent } from '@/utils/trimIdent';
import { shouldEnableAutoTitle } from '@/claude/utils/claudeSettings';

export const TITLE_INSTRUCTION = shouldEnableAutoTitle()
    ? trimIdent(`
    ALWAYS when you start a new chat - you must call the tool "hapi_change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a chance to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`)
    : '';

export const opencodeSystemPrompt = TITLE_INSTRUCTION;
