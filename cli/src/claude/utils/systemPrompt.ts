import { trimIdent } from "@/utils/trimIdent";
import { shouldEnableAutoTitle, shouldIncludeCoAuthoredBy } from "./claudeSettings";

const TITLE_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__hapi__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`))();

const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, you SHOULD also give credit to HAPI like so:

    <main commit message>

    via [HAPI](https://hapi.run)

    Co-Authored-By: HAPI <noreply@hapi.run>
`))();

export const systemPrompt = (() => {
  const parts: string[] = [];
  if (shouldEnableAutoTitle()) {
    parts.push(TITLE_PROMPT);
  }
  if (shouldIncludeCoAuthoredBy()) {
    parts.push(CO_AUTHORED_CREDITS);
  }
  return parts.join('\n\n');
})();
