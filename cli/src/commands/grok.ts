import chalk from 'chalk';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { initializeToken } from '@/ui/tokenInit';
import { maybeAutoStartServer } from '@/utils/autoStartServer';
import type { CommandDefinition } from './types';
import { GROK_PERMISSION_MODES } from '@hapi/protocol/modes';
import type { GrokPermissionMode } from '@hapi/protocol/types';

export const grokCommand: CommandDefinition = {
    name: 'grok', requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options: {
                startedBy?: 'runner' | 'terminal'; startingMode?: 'local' | 'remote'; permissionMode?: GrokPermissionMode;
                resumeSessionId?: string; model?: string; effort?: string;
            } = {};
            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i];
                if (arg === '--started-by') options.startedBy = commandArgs[++i] as any;
                else if (arg === '--hapi-starting-mode') {
                    const value = commandArgs[++i];
                    if (value !== 'local' && value !== 'remote') throw new Error('Invalid --hapi-starting-mode');
                    options.startingMode = value;
                } else if (arg === '--permission-mode') {
                    const value = commandArgs[++i];
                    if (!(GROK_PERMISSION_MODES as readonly string[]).includes(value)) throw new Error(`Invalid --permission-mode: ${value}`);
                    options.permissionMode = value as GrokPermissionMode;
                } else if (arg === '--yolo') options.permissionMode = 'yolo';
                else if (arg === '--resume') options.resumeSessionId = commandArgs[++i];
                else if (arg === '--model') options.model = commandArgs[++i];
                else if (arg === '--effort' || arg === '--reasoning-effort') options.effort = commandArgs[++i];
            }
            await initializeToken(); await maybeAutoStartServer(); await authAndSetupMachineIfNeeded();
            const { runGrok } = await import('@/grok/runGrok');
            await runGrok(options);
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
            if (process.env.DEBUG) console.error(error);
            process.exit(1);
        }
    }
};
