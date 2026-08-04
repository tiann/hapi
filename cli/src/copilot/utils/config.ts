export type CopilotModelSource = 'explicit' | 'default';

export function resolveCopilotRuntimeConfig(opts: {
    model?: string;
} = {}): { model: string | undefined; modelSource: CopilotModelSource } {
    if (opts.model) {
        return { model: opts.model, modelSource: 'explicit' };
    }
    return { model: undefined, modelSource: 'default' };
}
