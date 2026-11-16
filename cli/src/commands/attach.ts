import type { CommandDefinition } from './types';
import { initializeToken } from '@/ui/tokenInit';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { maybeAutoStartServer } from '@/utils/autoStartServer';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { initializeSharedClient } from '@/codex/shared/launch';
import { assertAttachableRoot, runAttachedRuntime, validateAttachedEndpoint, type AttachedOptions } from '@/codex/shared/attached';
import { findRuntime } from '@/codex/shared/registry';
import { runtimeControl } from '@/codex/shared/frontend';
import { record, string } from '@/codex/shared/gateway';

const HELP = `Experimental external Codex bridge (explicit external endpoint required).
  hapi attach <native-thread-id> --socket /absolute/path.sock [--new-view]
  hapi attach --socket /absolute/path.sock --list
  hapi detach <hapi-session-id>

The thread must already be loaded in the external app-server. Runs in the
foreground; Ctrl-C, detach and End session disconnect HAPI only. No app-server,
desktop configuration, login item or launchctl setting is created or changed.`;

export function parseAttachArgs(args: string[]): AttachedOptions & { list: boolean } {
    let endpoint: string | undefined; let threadId: string | undefined; let newView = false; let list = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--socket') {
            if (endpoint) throw new Error('Duplicate --socket');
            const path = args[++i];
            if (!path || path.startsWith('-')) throw new Error('Missing --socket path');
            endpoint = path.startsWith('unix://') ? path : `unix://${path}`;
        } else if (arg === '--new-view') newView = true;
        else if (arg === '--list') list = true;
        else if (arg.startsWith('-') || threadId) throw new Error(`Unexpected attach argument: ${arg}`);
        else threadId = arg;
    }
    if (!endpoint || list && (threadId || newView) || !list && !threadId) throw new Error(HELP);
    return { endpoint, threadId: threadId ?? '', newView, list };
}

async function listLoaded(endpoint: string): Promise<void> {
    const client = new CodexAppServerClient({ endpoint: await validateAttachedEndpoint(endpoint) });
    client.setServerRequestHandler(() => {});
    try {
        await initializeSharedClient(client);
        let cursor: string | undefined;
        do {
            const page = record(await client.request('thread/loaded/list', { cursor }));
            for (const id of Array.isArray(page.data) ? page.data : []) {
                if (typeof id !== 'string') continue;
                const thread = record(record(await client.request('thread/read', { threadId: id, includeTurns: false })).thread);
                try { assertAttachableRoot(thread, id); } catch { continue; }
                console.log(JSON.stringify({ threadId: id, name: thread.name ?? null, cwd: thread.cwd }));
            }
            cursor = string(page.nextCursor);
        } while (cursor);
    } finally { await client.disconnect(); }
}

export const attachCommand: CommandDefinition = {
    name: 'attach', requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.includes('--help') || commandArgs.includes('-h')) { console.log(HELP); return; }
        try {
            if (process.platform !== 'darwin') throw new Error('External desktop attachment is currently supported only on macOS');
            const { list, ...options } = parseAttachArgs(commandArgs);
            if (list) return await listLoaded(options.endpoint);
            await initializeToken(); await maybeAutoStartServer(); await authAndSetupMachineIfNeeded();
            await runAttachedRuntime(options, ({ sessionId }) => {
                console.log(`Attached HAPI session: ${sessionId}\nCtrl-C detaches HAPI only; the external thread keeps running.`);
            });
        } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    }
};

export const detachCommand: CommandDefinition = {
    name: 'detach', requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.includes('--help') || commandArgs.includes('-h')) { console.log(HELP); return; }
        try {
            if (commandArgs.length !== 1 || commandArgs[0].startsWith('-')) throw new Error('Usage: hapi detach <hapi-session-id>');
            await initializeToken();
            const runtime = await findRuntime(commandArgs[0]);
            if (!runtime || runtime.kind !== 'attached') throw new Error('No live attached worker for this session; owned runtimes are not detached by this command');
            await runtimeControl(runtime, 'hapi/detach', commandArgs[0]);
            console.log('HAPI detached; the external app-server and native queue were left intact.');
        } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    }
};
