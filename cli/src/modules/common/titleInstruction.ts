/** MCP `change_title` tool description. When to rename belongs here, not in every agent's prompt. */
export const CHANGE_TITLE_TOOL_DESCRIPTION =
    'Change the title of the current HAPI chat session. ' +
    'Call once when the user\'s primary objective is clear; use a concise task title. ' +
    'Do not rename for routine progress, substeps, implementation details, or slightly better wording. ' +
    'Rename only when the objective changes substantially and the existing title would be misleading.'

/** Always-on pointer: agents that list MCP tools by name only need a reason to call this one. */
export function buildTitleInstruction(tool: string): string {
    return `Set the chat title once with ${tool} when the task is clear; rename only if the goal changes substantially.`
}
