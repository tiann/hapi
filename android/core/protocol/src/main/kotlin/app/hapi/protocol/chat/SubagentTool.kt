package app.hapi.protocol.chat

/**
 * Port of `web/src/chat/subagentTool.ts` — 'Task' (older SDKs) and 'Agent'
 * (newer SDKs) are the same subagent concept and must be treated identically.
 */
fun isSubagentToolName(name: String): Boolean =
    name == "Task" || name == "Agent" || name.startsWith("Agent:") || name.startsWith("Task:")
