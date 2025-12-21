export function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

export function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

export function deriveToolName(input: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
}): string {
    if (input.title && input.title.trim().length > 0) {
        return input.title.trim();
    }

    if (isObject(input.rawInput)) {
        const fromName = input.rawInput.name;
        if (typeof fromName === 'string' && fromName.trim().length > 0) {
            return fromName.trim();
        }

        const fromTool = input.rawInput.tool;
        if (typeof fromTool === 'string' && fromTool.trim().length > 0) {
            return fromTool.trim();
        }
    }

    if (input.kind && input.kind.trim().length > 0) {
        return input.kind.trim();
    }

    return 'Tool';
}
