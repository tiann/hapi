import { isObject } from '@hapi/protocol';

type ToolNameSource = 'title' | 'raw_input_name' | 'raw_input_tool' | 'kind' | 'default';

export type CanonicalDiffToolInput =
    | { name: 'Edit'; input: { file_path: string; old_string: string; new_string: string; replace_all?: boolean } }
    | { name: 'Write'; input: { file_path: string; content: string } };

function firstString(value: unknown, keys: readonly string[]): string | null {
    if (!isObject(value)) return null;
    for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate === 'string') return candidate;
    }
    return null;
}

/**
 * Detects diff/write-shaped tool inputs emitted by ACP agents that keep their
 * native argument shapes (OpenCode: `{filePath, oldString, newString}` for
 * edit and `{filePath, content}` for write) and normalizes them to the
 * Claude-shaped inputs the web Edit/Write views render.
 *
 * Gated on the tool's semantic name/kind: only known edit/write aliases are
 * canonicalized. The Edit shape (path + both old/new strings) is unambiguous on
 * its own, but Write is just `{path, content}` — a shape many non-edit MCP
 * tools also accept — so without the gate those tools would be renamed to
 * Write and their extra args dropped. The gate keeps the OpenCode native-shape
 * cases (OpenCode maps both edit and write to kind 'edit', which is in the
 * allow-list) while avoiding that misclassification.
 *
 * Returns null when the semantic hint is missing/unknown, or the input shape
 * doesn't match, so callers keep their existing fallback.
 */
export function canonicalizeDiffToolInput(rawInput: unknown, semanticHint: string | null): CanonicalDiffToolInput | null {
    const kind = semanticHint?.trim().toLowerCase() ?? null;
    if (!kind || !['edit', 'write', 'write_file', 'replace', 'modify', 'file_edit'].includes(kind)) {
        return null;
    }

    const filePath = firstString(rawInput, ['filePath', 'file_path']);
    if (filePath === null || filePath.length === 0) return null;

    const oldString = firstString(rawInput, ['oldString', 'old_string']);
    const newString = firstString(rawInput, ['newString', 'new_string']);
    if (oldString !== null && newString !== null) {
        // OpenCode streams camelCase replaceAll; already-canonical inputs may
        // carry snake_case replace_all. Accept both so the execution argument
        // survives every call site.
        let replaceAll: boolean | undefined;
        if (isObject(rawInput)) {
            if (typeof rawInput.replaceAll === 'boolean') {
                replaceAll = rawInput.replaceAll;
            } else if (typeof rawInput.replace_all === 'boolean') {
                replaceAll = rawInput.replace_all;
            }
        }
        return {
            name: 'Edit',
            input: {
                file_path: filePath,
                old_string: oldString,
                new_string: newString,
                ...(replaceAll === undefined ? {} : { replace_all: replaceAll }),
            },
        };
    }

    const content = firstString(rawInput, ['content']);
    if (content !== null) {
        return { name: 'Write', input: { file_path: filePath, content } };
    }

    return null;
}

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
    metaKind?: string | null;
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

    // ACP agents (Gemini, Kimi) use kind=edit/write/replace with _meta.kind to
    // distinguish write_file (add) from replace (modify). Normalise the kind
    // so aliases like 'write', 'replace', 'modify' are handled the same way.
    const normalizedKind = typeof input.kind === 'string'
        ? input.kind.toLowerCase().trim()
        : null;
    if (normalizedKind === 'edit' || normalizedKind === 'write' || normalizedKind === 'write_file' || normalizedKind === 'replace' || normalizedKind === 'modify' || normalizedKind === 'file_edit') {
        if (input.metaKind === 'add') {
            return { name: 'Write', source: 'kind' };
        }
        if (input.metaKind === 'modify') {
            return { name: 'Edit', source: 'kind' };
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
    metaKind?: string | null;
}): string {
    return deriveToolNameWithSource(input).name;
}
