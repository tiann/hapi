export function extractExplicitResumeSessionId(args?: string[]): string | null {
    if (!args) {
        return null;
    }

    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--resume') {
            continue;
        }

        if (i + 1 >= args.length) {
            return null;
        }

        const nextArg = args[i + 1];
        return isExplicitResumeSessionId(nextArg) ? nextArg : null;
    }

    return null;
}

export function isExplicitResumeSessionId(value: string): boolean {
    return !value.startsWith('-') && value.includes('-');
}
