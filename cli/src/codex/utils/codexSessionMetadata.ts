export function isCodexSubagentSource(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(value, 'subagent');
}
