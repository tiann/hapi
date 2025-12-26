import { isBunCompiled } from '@/projectPath';

export type BunRuntimeEnvOptions = {
    allowBunBeBun?: boolean;
};

function stripBunBeBun(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!('BUN_BE_BUN' in env)) {
        return env;
    }

    const copy = { ...env };
    delete copy.BUN_BE_BUN;
    return copy;
}

export function withBunRuntimeEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: BunRuntimeEnvOptions = {}
): NodeJS.ProcessEnv {
    if (!isBunCompiled()) {
        return env;
    }

    if (options.allowBunBeBun === false) {
        return stripBunBeBun(env);
    }

    return {
        ...env,
        BUN_BE_BUN: '1'
    };
}
