import { AcpSdkBackend } from '@/agent/backends/acp';
import type { CopilotAgentMode } from '@hapi/protocol';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/** ACP process args. Non-interactive modes use `--mode` so Plan/Autopilot apply at spawn. */
export function buildCopilotAcpArgs(opts?: { agentMode?: CopilotAgentMode }): string[] {
    const args = ['--acp', '--stdio'];
    if (opts?.agentMode && opts.agentMode !== 'interactive') {
        args.push('--mode', opts.agentMode);
    }
    return args;
}

export function createCopilotBackend(opts?: { agentMode?: CopilotAgentMode }): AcpSdkBackend {
    return new AcpSdkBackend({
        command: getAgentLaunchCommand('copilot'),
        args: buildCopilotAcpArgs(opts),
        env: filterEnv(process.env)
    });
}
