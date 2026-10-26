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
    if (bunMain) {
        return value === bunMain;
    }
    return /\.(c|m)?(ts|js)$/.test(value);
}

export function normalizeCliArgs(rawArgv: string[]): string[] {
    if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
        return [];
    }

    const execPath = process.execPath;
    const execBase = basename(execPath);
    const bunMain = globalThis.Bun?.main ?? '';
    const argv = rawArgv;

    let startIndex = 0;
    const nextValue = argv[1] || '';
    if (argv[0] === 'bun' && (
        nextValue === execPath || nextValue === execBase || isEntrypointPath(nextValue, bunMain)
    )) {
        startIndex += 1;
    }
    if (argv[startIndex] === execPath || argv[startIndex] === execBase) {
        startIndex += 1;
    }
    // Consume at most one entrypoint. Later filenames, even *.ts / *.js, are
    // user arguments, not additional runtime wrappers.
    if ((startIndex > 0 || (bunMain && argv[0] === bunMain))
        && isEntrypointPath(argv[startIndex] || '', bunMain)) {
        startIndex += 1;
    }

    // Only a separator immediately after the runtime/entrypoint is a wrapper
    // separator. A later `--` belongs to the selected command and its arguments.
    if (startIndex > 0 && argv[startIndex] === '--') {
        startIndex += 1;
    }
    return argv.slice(startIndex);
}

export function getCliArgs(): string[] {
    return normalizeCliArgs(resolveRawArgv());
}
