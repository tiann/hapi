export function withBunRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const bunRuntime = (globalThis as typeof globalThis & { Bun?: { isCompiled?: boolean } }).Bun;
    const argv1 = process.argv[1] ?? '';
    const isCompiled = Boolean(bunRuntime?.isCompiled) || argv1.includes('$bunfs');

    if (!isCompiled) {
        return env;
    }

    return {
        ...env,
        BUN_BE_BUN: '1'
    };
}
