import { AcpSdkBackend } from '@/agent/backends/acp';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

/**
 * GEMINI_FORCE_FILE_STORAGE reads the saved OAuth token instead of a flaky
 * keyring. SSH session markers would switch agy to a degraded auth path, but
 * the agent socket stays for tool subprocesses.
 */
export function buildAgyAcpEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) env[key] = value;
    }
    env.GEMINI_FORCE_FILE_STORAGE = 'true';
    for (const key of ['SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY']) {
        delete env[key];
    }
    return env;
}

export function createAgyAcpBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: getAgentLaunchCommand('agy'),
        args: ['acp'],
        env: buildAgyAcpEnv(),
        flavor: 'agy',
        // agy then asks its ask_question questions as form elicitations.
        elicitationForm: true
    });
}
