/** How generated media entered the session (v1 provenance seed for #956 / artifact follow-up). */
export type InlineMediaIngress = 'mcp' | 'acp' | 'tool_result';

export type InlineMediaSource = {
    ingress: InlineMediaIngress;
    flavor?: string;
    toolCallId?: string;
    toolName?: string;
};
