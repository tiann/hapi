export function countHookCoveredExecCalls(source: unknown): number | null {
    if (typeof source !== 'string' || source.length === 0) return null;

    const toolReference = /\btools\b/g;
    let toolCount = 0;

    for (const match of source.matchAll(toolReference)) {
        const tail = source.slice((match.index ?? 0) + match[0].length).trimStart();
        let toolName: string | null = null;

        if (tail.startsWith('.')) {
            toolName = tail.slice(1).match(/^[$A-Z_a-z][$\w]*/)?.[0] ?? null;
        } else if (tail.startsWith('[')) {
            const bracket = tail.match(/^\[\s*(['"])([$A-Z_a-z][$\w]*(?:__[$A-Z_a-z][$\w]*)*)\1\s*\]/);
            toolName = bracket?.[2] ?? null;
        }

        if (!toolName) {
            return null;
        }
        toolCount += 1;
    }

    return toolCount > 0 ? toolCount : null;
}

export function isFullyHookCoveredExecSource(source: unknown): boolean {
    return countHookCoveredExecCalls(source) !== null;
}
