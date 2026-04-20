import { trimIdent } from '@/utils/trimIdent';
import { shouldEnableAutoTitle } from '@/claude/utils/claudeSettings';

export const TITLE_INSTRUCTION = shouldEnableAutoTitle()
    ? trimIdent(`
    ALWAYS when you start a new chat, call the title tool to set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    If the task focus changes significantly later, call the title tool again with a better title.
`)
    : '';

export const codexSystemPrompt = TITLE_INSTRUCTION;
