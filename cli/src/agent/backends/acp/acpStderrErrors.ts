import type { AcpStderrError } from './AcpStdioTransport';

export function matchesAcpRetryBackoff(text: string): boolean {
    return text.toLowerCase().includes('retrying in');
}

export function matchesAcpHttp2Cancel(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes('http/2') && (lower.includes('cancel') || lower.includes('0x8'));
}

export function isAcpStallStderrError(error: AcpStderrError): boolean {
    if (error.type === 'rate_limit' || error.type === 'quota_exceeded') {
        return true;
    }

    const text = `${error.message}\n${error.raw}`;
    return matchesAcpRetryBackoff(text) || matchesAcpHttp2Cancel(text);
}
