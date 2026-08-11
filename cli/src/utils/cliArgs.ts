import { basename } from 'node:path';

function resolveRawArgv(): string[] {
    const bunArgv = globalThis.Bun?.argv;
    if (Array.isArray(bunArgv) && bunArgv.length > 0) {
        return bunArgv;
    }
    return process.argv;
}

function isEntrypointPath(value: string, bunMain: string): boolean {
    if (!value) {
        return false;
    }
    if (value === bunMain) {
        return true;
    }
    return /\.(c|m)?(ts|js)$/.test(value);
}

function hasRuntimeWrapper(preArgs: string[], execPath: string, execBase: string, bunMain: string): boolean {
    if (preArgs.length === 0) {
        return false;
    }
    if (preArgs[0] === 'bun') {
        return true;
    }
    if (preArgs.length < 2) {
        return false;
    }
    if (preArgs[0] !== execPath && preArgs[0] !== execBase) {
        return false;
    }
    return isEntrypointPath(preArgs[1], bunMain);
}

/** Drop bun/exec/entrypoint prefix so we can see if a HAPI command already follows. */
function stripRuntimePrefix(
    args: string[],
    execPath: string,
    execBase: string,
    bunMain: string
): string[] {
    let startIndex = 0;
    while (startIndex < args.length) {
        const value = args[startIndex] || '';
        const nextValue = args[startIndex + 1] || '';
        if (
            value === 'bun' &&
            (nextValue === bunMain || nextValue === execPath || nextValue === execBase || isEntrypointPath(nextValue, bunMain))
        ) {
            startIndex += 2;
            continue;
        }
        if (value === execPath || value === execBase || isEntrypointPath(value, bunMain)) {
            startIndex += 1;
            continue;
        }
        break;
    }
    return args.slice(startIndex);
}

export function normalizeCliArgs(rawArgv: string[]): string[] {
    if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
        return [];
    }

    const execPath = process.execPath;
    const execBase = basename(execPath);
    const bunMain = globalThis.Bun?.main ?? '';
    const dashIndex = rawArgv.indexOf('--');
    let argv = rawArgv.slice();
    if (dashIndex >= 0) {
        const preArgs = rawArgv.slice(0, dashIndex);
        const postArgs = rawArgv.slice(dashIndex + 1);
        const normalizedPre = stripRuntimePrefix(preArgs, execPath, execBase, bunMain);
        // Only `job run … -- <cmd>` needs the child separator preserved.
        // `hapi -- auth login` / `hapi codex -- --model o3` must keep stripping.
        const keepSeparator = normalizedPre[0] === 'job' && normalizedPre[1] === 'run';
        if (
            hasRuntimeWrapper(preArgs, execPath, execBase, bunMain)
            && normalizedPre.length === 0
        ) {
            // `bun src/index.ts -- auth login` → only postArgs (runtime handoff).
            argv = postArgs;
        } else {
            argv = keepSeparator
                ? [...preArgs, '--', ...postArgs]
                : [...preArgs, ...postArgs];
        }
    }

    return stripRuntimePrefix(argv, execPath, execBase, bunMain);
}

export function getCliArgs(): string[] {
    return normalizeCliArgs(resolveRawArgv());
}
