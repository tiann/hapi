export type AgyTranscriptEntry = {
    step_index: number
    source: 'USER_EXPLICIT' | 'MODEL' | 'SYSTEM'
    // Known transcript step types. agy emits many more (RUN_COMMAND,
    // LIST_DIRECTORY, CODE_ACTION, ...) which the runtime treats open-endedly
    // as tool actions — the trailing `(string & {})` keeps the union honest
    // (any string) while preserving autocomplete for the named ones.
    type: 'USER_INPUT' | 'PLANNER_RESPONSE' | 'VIEW_FILE' | 'CONVERSATION_HISTORY' | (string & {})
    status: 'DONE'
    created_at: string
    content?: string
    tool_calls?: AgyToolCall[]
    // Model that produced this turn (display name, e.g. "Gemini 3.5 Flash
    // (Medium)"), enriched by the scanner from the conversation DB for agent
    // responses. Not present in the raw transcript JSONL.
    model?: string
}

export type AgyToolCall = {
    name: string
    // Raw agy tool arguments. Values are usually strings (CommandLine,
    // AbsolutePath, …) but agy also emits non-string args (e.g.
    // WaitMsBeforeAsync), so keep this open and let the web normalizer pick the
    // fields it renders.
    args: Record<string, unknown>
}
