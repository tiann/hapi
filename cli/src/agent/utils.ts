import { isObject } from '@hapi/protocol';

type ToolNameSource = 'title' | 'raw_input_name' | 'raw_input_tool' | 'kind' | 'default';

function normalizeToolName(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function isPlaceholderToolName(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === '' || normalized === 'tool' || normalized === 'unknown' || normalized === 'other';
}

export function deriveToolNameWithSource(input: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
}): { name: string; source: ToolNameSource } {
    const title = normalizeToolName(input.title);
    if (title) {
        return { name: title, source: 'title' };
    }

    if (isObject(input.rawInput)) {
        const fromName = normalizeToolName(input.rawInput.name);
        if (fromName) {
            return { name: fromName, source: 'raw_input_name' };
        }

        const fromTool = normalizeToolName(input.rawInput.tool);
        if (fromTool) {
            return { name: fromTool, source: 'raw_input_tool' };
        }
    }

    const kind = normalizeToolName(input.kind);
    if (kind && !isPlaceholderToolName(kind)) {
        return { name: kind, source: 'kind' };
    }

    return { name: 'Tool', source: 'default' };
}

export function deriveToolName(input: {
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
}): string {
    return deriveToolNameWithSource(input).name;
}
