import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { configuration } from '@/configuration';
import { readSettings } from '@/persistence';
import { getProcessStartMarker } from '@/utils/process';
import { notifyRunnerSessionStarted } from '@/runner/controlClient';
import { CodexAppServerClient } from '../codexAppServerClient';
import { record, string } from './gateway';
import { checkSharedCapabilities } from './launch';
import { SharedCodexRoot } from './root';
import { findAttachedBinding, runtimeAuthHash, runtimeDirectory, saveRuntime, withThreadOwnership, type CodexRuntimeRecord } from './registry';
import { startAttachedControl } from './attachedControl';
import { AttachedHistoryChangedError, validateAttachedHistory } from './attachedHistory';

export const AttachedOptionsSchema = z.object({
    endpoint: z.string().min(1), threadId: z.string().min(1), newView: z.boolean().optional(),
    startedBy: z.enum(['runner', 'terminal']).optional(), desktopHome: z.string().optional()
}).strict().refine(options => !options.newView || options.desktopHome === undefined, 'Automatic sync cannot replace an existing view');
export type AttachedOptions = z.infer<typeof AttachedOptionsSchema>;
export type AttachedReady = { sessionId: string; runtime: CodexRuntimeRecord };
export type AttachedStopReason = 'detached' | 'unavailable' | 'history-changed' | 'archived';
export class AttachedIneligibleThreadError extends Error {}

/** Explicitly trusted, same-user local UDS only. Official daemon symlinks are supported. */
export async function validateAttachedEndpoint(endpoint: string): Promise<string> {
    if (!endpoint.startsWith('unix://') || !isAbsolute(endpoint.slice(7)) || /[\0\r\n]/.test(endpoint)) {
        throw new Error('Attach requires unix:///absolute/socket/path; TCP and remote endpoints are not supported');
    }
    // Bun/macOS realpath(socket) can return EOPNOTSUPP. Canonicalize the
    // directory and explicitly follow leaf symlinks instead; never ignore
    // errors or weaken the final socket/owner/mode checks.
    let path = endpoint.slice(7);
    for (let hops = 0; ; hops++) {
        if (hops >= 40) throw new Error('Too many attached socket symlinks');
        path = join(await realpath(dirname(path)), basename(path));
        if (!(await lstat(path)).isSymbolicLink()) break;
        path = resolve(dirname(path), await readlink(path));
    }
    const socket = await stat(path); const parent = await stat(dirname(path));
    const uid = process.getuid?.();
    if (uid === undefined || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0 || parent.uid !== uid || (parent.mode & 0o022) !== 0) {
        throw new Error('Attach requires a same-user Unix socket in a non-writable-by-others directory');
    }
    return `unix://${path}`;
}

export async function* loadedThreadIds(client: CodexAppServerClient): AsyncGenerator<string> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
        const page = z.object({ data: z.array(z.string()), nextCursor: z.string().nullish() }).parse(await client.request('thread/loaded/list', { cursor }));
        yield* page.data;
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Codex repeated a loaded-thread cursor');
        if (cursor) seen.add(cursor);
    } while (cursor);
}

export async function requireLoadedThread(client: CodexAppServerClient, threadId: string): Promise<void> {
    for await (const id of loadedThreadIds(client)) if (id === threadId) return;
    throw new Error('Thread is not loaded in the external engine. Open it in the owning desktop first; HAPI will not cold-resume it.');
}

export function assertAttachableRoot(thread: Record<string, unknown>, threadId: string): string {
    const source = thread.source;
    if (thread.id !== threadId || thread.parentThreadId || thread.ephemeral === true
        || typeof source === 'object' && source !== null || typeof source === 'string' && /subagent/i.test(source)) {
        throw new AttachedIneligibleThreadError('Only persistent user-root threads can be attached');
    }
    const cwd = string(thread.cwd);
    if (!cwd || !isAbsolute(cwd)) throw new Error('Native thread has no absolute working directory');
    return cwd;
}

/** One independent bridge worker. It never starts, configures, archives or kills the external engine. */
export async function runAttachedRuntime(raw: AttachedOptions, onReady?: (ready: AttachedReady) => void, signal?: AbortSignal): Promise<AttachedStopReason> {
    const options = AttachedOptionsSchema.parse(raw);
    signal?.throwIfAborted();
    const endpoint = await validateAttachedEndpoint(options.endpoint);
    const observer = new CodexAppServerClient({ endpoint });
    observer.setServerRequestHandler(() => {});
    let root: SharedCodexRoot | undefined;
    let session: ApiSessionClient | undefined;
    let control: Awaited<ReturnType<typeof startAttachedControl>> | undefined;
    let runtime: CodexRuntimeRecord | undefined;
    const lifecycle: { reason: AttachedStopReason } = { reason: 'detached' };
    let stopping = false;
    let finish!: () => void;
    const stopped = new Promise<void>(resolve => { finish = resolve; });
    const stop = (next: AttachedStopReason = 'detached') => {
        if (next === 'history-changed' || !stopping) lifecycle.reason = next;
        stopping = true; root?.stopAccepting(); finish();
    };
    const onSignal = () => stop();
    const assertRunning = () => { signal?.throwIfAborted(); if (stopping) throw new Error('Attached worker is stopping'); };
    signal?.addEventListener('abort', onSignal, { once: true });
    if (!signal) for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(event, onSignal);
    observer.setTransportAbandonedHandler(() => stop('unavailable'));
    try {
        if (signal?.aborted) stop();
        assertRunning();
        await observer.connect();
        const initialized = await observer.initialize({ clientInfo: { name: 'hapi_attached_observer', version: '1' }, capabilities: { experimentalApi: true } });
        const homePath = string(record(initialized).codexHome);
        if (!homePath || !isAbsolute(homePath)) throw new Error('External engine did not report CODEX_HOME');
        const home = await realpath(homePath);
        if (options.desktopHome !== undefined && home !== await realpath(options.desktopHome)) {
            throw new Error('Desktop daemon reported a different CODEX_HOME');
        }
        const homeStat = await stat(home);
        if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.() || (homeStat.mode & 0o022) !== 0) {
            throw new Error('External CODEX_HOME must be owned by this user and not writable by others');
        }
        await checkSharedCapabilities(observer);
        await requireLoadedThread(observer, options.threadId);
        const thread = record(record(await observer.request('thread/read', { threadId: options.threadId, includeTurns: false })).thread);
        const cwd = await realpath(assertAttachableRoot(thread, options.threadId));
        if (!(await stat(cwd)).isDirectory()) throw new Error('Native working directory is not a directory');
        const id = randomUUID(); const marker = getProcessStartMarker(process.pid);
        if (!marker) throw new Error('Cannot verify attached worker process generation');
        runtime = { id, kind: 'attached', pid: process.pid, marker, endpoint: '', nativeEndpoint: endpoint, attachedAt: Date.now(),
            command: '', args: [], codexHome: home, hub: configuration.apiUrl, authHash: runtimeAuthHash(), sessions: {} };
        await withThreadOwnership(home, options.threadId, id, async () => {
            assertRunning();
            let existing = await findAttachedBinding(home, options.threadId);
            // Automatic retries after a lost Hub response must reuse the same
            // initial row/binding even before a local runtime record exists.
            const seed = options.desktopHome !== undefined ? createHash('sha256')
                .update(JSON.stringify([home, options.threadId, (await readSettings()).machineId])).digest('hex') : undefined;
            let bindingId = seed === undefined ? randomUUID()
                : `${seed.slice(0, 8)}-${seed.slice(8, 12)}-8${seed.slice(13, 16)}-8${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
            if (existing) {
                const session = await (await ApiClient.create()).getSession(existing);
                // The initial desktop binding may have reached the local
                // registry just before its native ID was flushed to the Hub.
                const partialDesktopBinding = seed !== undefined && session.metadata?.codexSessionId === undefined
                    && session.metadata?.codexRuntime?.bindingId === bindingId;
                if (session.metadata?.codexRuntime?.kind !== 'attached' || session.metadata.path !== cwd
                    || !(session.metadata.codexSessionId === options.threadId || partialDesktopBinding)) {
                    throw new Error('Attached binding identity mismatch');
                }
                if (options.newView) {
                    if (!session.metadata.conversationHistoryDiverged) throw new Error('--new-view is only for a view frozen after a native history rewrite');
                    runtime!.supersedes = existing;
                    existing = undefined;
                } else {
                    if (session.metadata.conversationHistoryDiverged) throw new AttachedHistoryChangedError();
                    bindingId = session.metadata.codexRuntime.bindingId;
                }
            } else if (options.newView) throw new Error('No previous attached view to replace');
            const bootstrapOptions = { flavor: 'codex', startedBy: options.startedBy ?? 'terminal', workingDirectory: cwd,
                ...(seed !== undefined ? { tag: `codex-desktop:${seed}` } : {}),
                exportSessionEnv: false, reportStarted: false, metadataOverrides: {
                    codexRuntime: { kind: 'attached', bindingId, state: 'attached' },
                    ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
                    capabilities: { terminal: false, concurrentClients: true, conversationHistory: {
                        forkCurrent: false, forkAtMessage: false, forkLatestCompleted: false, rewindToMessage: false
                    } }
                }
            } as const;
            const bootstrap = existing
                ? await bootstrapExistingSession({ ...bootstrapOptions, sessionId: existing })
                : await bootstrapSession({ ...bootstrapOptions, agentState: { controlledByUser: false } });
            session = bootstrap.session;
            if (seed !== undefined && bootstrap.sessionInfo.metadata?.conversationHistoryDiverged) throw new AttachedHistoryChangedError();
            const verifyHubBinding = async () => {
                if (!await bootstrap.session.flushMetadata()) throw new Error('Cannot persist attached runtime metadata');
                const persisted = await (await ApiClient.create()).getSession(bootstrap.session.sessionId);
                if (persisted.metadata?.codexRuntime?.kind !== 'attached' || persisted.metadata.codexRuntime.bindingId !== bindingId) {
                    throw new Error('Hub does not preserve attached runtime identity; update CLI, Hub and Runner together');
                }
            };
            // Check before exposing the native ID: older hubs must not dedupe
            // this row into an owned session or offer an owned resume fallback.
            await verifyHubBinding(); assertRunning();
            root = new SharedCodexRoot(bootstrap, {
                attached: true, directory: join(runtimeDirectory(), 'queues'), generation: id, endpoint,
                settingsFor: () => undefined,
                beforeSubscribe: threadId => requireLoadedThread(observer, threadId),
                create: async () => { throw new Error('Create external threads in the owning desktop'); },
                end: async (_root, _archive, why) => { stop(why ?? 'detached'); },
                validateHistory: async (threadId, history) => {
                    const key = createHash('sha256').update(threadId).digest('hex');
                    try { await validateAttachedHistory(join(runtimeDirectory(), 'attached-history', `${bootstrap.session.sessionId}-${key}.json`), history); }
                    catch (error) {
                        if (error instanceof AttachedHistoryChangedError) {
                            bootstrap.session.updateMetadata(metadata => ({ ...metadata, conversationHistoryDiverged: true }));
                            stop('history-changed');
                        } else stop('unavailable');
                        throw error;
                    }
                }
            });
            assertRunning();
            await root.prepare(); assertRunning();
            await root.bind(options.threadId, { thread }, true); assertRunning();
            control = await startAttachedControl(root.session.sessionId, () => stop());
            runtime!.endpoint = control.endpoint; runtime!.token = control.token;
            runtime!.sessions[root.session.sessionId] = { threadId: options.threadId, namespace: bootstrap.sessionInfo.namespace, active: true };
            await saveRuntime(runtime!); assertRunning();
            await verifyHubBinding(); assertRunning();
            await root.activate(); assertRunning();
            if (!await root.session.flush()) throw new Error('Cannot confirm attached session readiness');
            assertRunning();
            // The desktop supervisor hosts many independent runtime records on
            // one PID. Do not register it as a Runner-managed process.
            if (options.desktopHome === undefined) await notifyRunnerSessionStarted(root.session.sessionId, { ...bootstrap.metadata, hostStartMarker: marker });
            assertRunning();
            onReady?.({ sessionId: root.session.sessionId, runtime: runtime! });
        }, undefined, 'attached');
        await stopped;
    } catch (error) {
        // Signals/detach are successful even while startup is still awaiting
        // native or Hub I/O. Actual startup/validation failures remain errors.
        if (!stopping) { lifecycle.reason = 'unavailable'; throw error; }
        if (lifecycle.reason !== 'detached') throw error;
    } finally {
        stopping = true; root?.stopAccepting();
        signal?.removeEventListener('abort', onSignal);
        if (!signal) for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(event, onSignal);
        observer.setTransportAbandonedHandler(null);
        await control?.close();
        await observer.disconnect();
        if (root) {
            const state = lifecycle.reason === 'archived' ? 'detached' : lifecycle.reason;
            root.session.updateMetadata(metadata => metadata.codexRuntime ? ({ ...metadata,
                codexRuntime: { ...metadata.codexRuntime, state } }) : metadata);
            // Deliberately NOT suspend(): queued input belongs to the native engine.
            await root.close(lifecycle.reason === 'archived');
        } else if (session) {
            session.updateMetadata(metadata => metadata.codexRuntime ? ({ ...metadata,
                codexRuntime: { ...metadata.codexRuntime, state: 'unavailable' } }) : metadata);
            session.sendSessionDeath(undefined, { preserveUploads: true });
            await session.flush(); session.close();
        }
        if (runtime && Object.keys(runtime.sessions).length) {
            for (const binding of Object.values(runtime.sessions)) binding.active = false;
            await saveRuntime(runtime);
        }
    }
    return lifecycle.reason;
}
