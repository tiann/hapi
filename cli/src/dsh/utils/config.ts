export type DshModelSource = 'explicit' | 'local' | 'default';

const DEFAULT_DSH_MODEL = 'deepseek-v4-pro';

/**
 * Resolves which model id hapi should ask DeepSeek Harness to use. DSH has no
 * kimi-code style config.toml: the model is either explicit, read from
 * `DSH_MODEL`, or the cordis.yml default `deepseek-v4-pro`. The
 * { model, modelSource } shape mirrors resolveKimiRuntimeConfig so runDsh and
 * the launcher need no call-site changes.
 */
export function resolveDshRuntimeConfig(opts: {
    model?: string;
} = {}): { model: string | undefined; modelSource: DshModelSource } {
    if (opts.model) {
        return { model: opts.model, modelSource: 'explicit' };
    }

    const envModel = process.env.DSH_MODEL?.trim();
    if (envModel) {
        return { model: envModel, modelSource: 'local' };
    }

    return { model: DEFAULT_DSH_MODEL, modelSource: 'default' };
}
