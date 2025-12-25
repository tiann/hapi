import { AgentRegistry } from '@/agent/AgentRegistry';
import { AcpSdkBackend } from '@/agent/backends/acp';

function parseArgs(value?: string): string[] | null {
    if (!value) return null;
    const parts = value.split(' ').map((part) => part.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
}

function buildEnv(): Record<string, string> {
    return Object.keys(process.env).reduce((acc, key) => {
        const value = process.env[key];
        if (typeof value === 'string') {
            acc[key] = value;
        }
        return acc;
    }, {} as Record<string, string>);
}

const command = process.env.HAPPY_GEMINI_COMMAND
    || process.env.GEMINI_ACP_COMMAND
    || 'gemini';

const args = parseArgs(process.env.HAPPY_GEMINI_ARGS)
    ?? parseArgs(process.env.GEMINI_ACP_ARGS)
    ?? ['--experimental-acp'];

AgentRegistry.register('gemini', () => new AcpSdkBackend({
    command,
    args,
    env: buildEnv()
}));
