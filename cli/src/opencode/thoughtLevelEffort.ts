import type { AgentSessionConfigOptionDescriptor } from '@/agent/types';

export function resolveThoughtLevelEffort(
    requested: string,
    thoughtLevelOption: AgentSessionConfigOptionDescriptor,
    fallback: string | null
): string | null {
    const supported = new Set(thoughtLevelOption.options.map((option) => option.value));
    if (supported.has(requested)) {
        return requested;
    }
    if (fallback && supported.has(fallback)) {
        return fallback;
    }
    const current = thoughtLevelOption.currentValue;
    if (current && supported.has(current)) {
        return current;
    }
    return thoughtLevelOption.options[0]?.value ?? null;
}
