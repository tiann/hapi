import { AGY_TITLE_MARKER } from './systemPrompt';

export function extractAgyTitleMarker(text: string): { title: string | null; text: string } {
    const normalized = text.replace(/^\uFEFF/, '');
    const match = normalized.match(new RegExp(`^${AGY_TITLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(.+?)\\s*(?:\\r?\\n|$)`));
    if (!match) {
        return { title: null, text };
    }

    const title = match[1].trim();
    const withoutMarker = normalized.slice(match[0].length).replace(/^\r?\n/, '');
    return {
        title: title.length > 0 ? title : null,
        text: withoutMarker
    };
}

function stripLeadingAttachmentLines(text: string): string {
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && /^@\S+/.test(lines[0].trim())) {
        lines.shift();
    }
    return lines.join('\n').trim();
}

export function deriveAgyFallbackTitle(userMessage: string): string {
    const cleaned = stripLeadingAttachmentLines(userMessage)
        .replace(/\s+/g, ' ')
        .trim();
    const base = cleaned || 'Antigravity agy';
    const maxLength = 34;
    if ([...base].length <= maxLength) {
        return base;
    }
    return [...base].slice(0, maxLength).join('').trimEnd();
}
