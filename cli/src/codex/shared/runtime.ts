import { CodexTierDiscoveryError, catalogConfiguration, nativeTierParams, inheritedResumeTier, resolveUltrafastLaunch, ULTRAFAST_FALLBACK_NOTICE, type UltrafastTarget } from '../utils/serviceTier';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, chmod, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadGoal } from '../appServerTypes';
import { configuration } from '@/configuration';
import { bootstrapSession, bootstrapExistingSession } from '@/agent/sessionFactory';
import { notifyRunnerSessionStarted } from '@/runner/controlClient';
import { getProcessStartMarker, killProcessByChildProcess } from '@/utils/process';
import { logger } from '@/ui/logger';
import { CodexAppServerClient, isIndeterminateError } from '../codexAppServerClient';
import { codexHome, saveRuntime, runtimeDirectory, runtimeAuthHash, findColdBinding, withThreadOwnership, type CodexRuntimeRecord } from './registry';
import { startCodexGateway, record, string, type Envelope } from './gateway';
import { resolveSharedCodex, sharedLaunchConfig, coldResumeDirectory, initializeSharedClient, checkSharedCapabilities, takeReservedSessionId, type SharedLaunchOptions } from './launch';
import { SharedCodexRoot, UltrafastTargetChangedError } from './root';
import { buildForkSessionSummary } from '@hapi/protocol';

export type RuntimeReady = { sessionId: string; runtime: CodexRuntimeRecord };
type TierDiscoveryFailure = { kind: 'ultrafast' | 'inherited'; reason?: string };
type Reservation = {
    root: SharedCodexRoot;
    executionParams: Record<string, unknown>;
    resumeId?: string;
    freshThread?: boolean;
    initialOptions?: SharedLaunchOptions;
    serviceTierExplicit?: boolean;
    ultrafastTarget?: UltrafastTarget;
    downgraded?: boolean;
    rootBound?: boolean;
    controlSubscription?: number;
    tierConfirmationPending?: boolean;
    heldGoal?: ThreadGoal;
};

function gitInfo(cwd: string): { sha: string | null; branch: string | null; originUrl: string | null } {
    const git = (...args: string[]) => {
        try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
        catch { return null; }
    };
    let originUrl = git('remote', 'get-url', 'origin');
    if (originUrl && /^https?:/.test(originUrl)) {
        try { const url = new URL(originUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; originUrl = url.toString(); }
        catch { originUrl = null; }
    }
    return { sha: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', '--short', 'HEAD'), originUrl };
}

function rejoinThreadParams(params: Record<string, unknown>): Record<string, unknown> {
    // Codex can rebuild an idle thread when an override differs and all
    // subscribers have disconnected. Rejoin the already accepted settings.
    return { threadId: params.threadId, excludeTurns: params.excludeTurns, initialTurnsPage: params.initialTurnsPage };
}
const NATIVE_INPUT_METHODS = new Set([
    'turn/start', 'turn/steer', 'review/start', 'thread/compact/start',
    'thread/realtime/start', 'thread/realtime/appendAudio', 'thread/realtime/appendText', 'thread/realtime/appendSpeech'
]);
function requiresTierAdmission(root: SharedCodexRoot, tier: unknown, downgraded: boolean, explicitTier?: boolean): boolean {
    const metadata = root.session.getMetadata();
    return downgraded || tier === 'ultrafast' || metadata?.codexTierConfirmationPending === true
        || metadata?.codexInheritedTierDiscoveryPending === true || root.requiresEffectiveFastConfirmation(tier, explicitTier);
}
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No private port');
    await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}

/** One ordinary CLI execution owns one private engine, with concurrent frontends. */
export async function runSharedRuntime(options: SharedLaunchOptions, onReady?: (ready: RuntimeReady) => void, abortSignal?: AbortSignal): Promise<void> {
    abortSignal?.throwIfAborted();
    const command = resolveSharedCodex();
    const launch = sharedLaunchConfig(options, options.workingDirectory ?? process.cwd());
    const id = randomUUID();
    await mkdir(codexHome(), { recursive: true, mode: 0o700 });
    const home = await realpath(codexHome());
    await mkdir(runtimeDirectory(), { recursive: true, mode: 0o700 });
    // Unix sockaddr_un has a small path limit; don't nest sockets under CODEX_HOME.
    const sockets = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'hapi-cx-')); await chmod(sockets, 0o700);
    const token = randomBytes(32).toString('hex');
    const upstream = process.platform === 'win32' ? `ws://127.0.0.1:${await freePort()}` : `unix://${join(sockets, 'engine.sock')}`;
    const upstreamToken = process.platform === 'win32' ? randomBytes(32).toString('hex') : undefined;
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    // Every thread injects its own identity. A launch from another agent must not inherit that root's identity.
    delete env.HAPI_SESSION_ID;
    let server: ChildProcess | undefined;
    let gateway: Awaited<ReturnType<typeof startCodexGateway>> | undefined;
    let stopping = false;
    let failure: unknown;
    let shutdownPromise: Promise<void> | undefined;
    let startup: Promise<void> = Promise.resolve();
    const operations = new Set<Promise<unknown>>();
    const assertRunning = () => { if (stopping) throw new Error('Codex execution is stopping'); };
    const operation = async <T>(work: () => Promise<T>): Promise<T> => {
        assertRunning();
        const pending = work(); operations.add(pending);
        try { return await pending; } finally { operations.delete(pending); }
    };
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const ending = new Set<SharedCodexRoot>();
    const nativeLifecycles = new Map<string, Promise<unknown>>();
    const serializeNativeLifecycle = <T>(threadId: string, work: () => Promise<T>): Promise<T> => {
        const pending = (nativeLifecycles.get(threadId) ?? Promise.resolve()).catch(() => {}).then(work);
        nativeLifecycles.set(threadId, pending);
        return pending.finally(() => {
            if (nativeLifecycles.get(threadId) === pending) nativeLifecycles.delete(threadId);
        });
    };
    const roots = new Map<string, SharedCodexRoot>();
    const prepared = new Set<SharedCodexRoot>();
    const reservations = new Map<string, Reservation>();
    const pendingAdmission = new Set<string>();
    const resumingThreads = new Set<string>();
    const retryableBindings = new Map<string, Reservation>();
    const nativeTurns = new Map<string, { root: SharedCodexRoot; explicitTier: boolean } & Awaited<ReturnType<SharedCodexRoot['prepareNativeTurn']>>>();
    const runtime: CodexRuntimeRecord = { id, pid: process.pid, marker: getProcessStartMarker(process.pid) ?? '',
        endpoint: '', command: command.command, args: command.args, codexHome: home, hub: configuration.apiUrl, authHash: runtimeAuthHash(), sessions: {} };
    if (!runtime.marker) throw new Error('Cannot verify the runtime process generation');
    let writes = Promise.resolve();
    const persist = () => { writes = writes.catch(() => {}).then(() => saveRuntime(runtime)); return writes; };
    let startupCatalogConfig: unknown = null;
    const control = new CodexAppServerClient({ endpoint: upstream, token: upstreamToken, cwd: launch.cwd });
    const withNativeLaunchTier = async (params: Record<string, unknown>, cwd: string): Promise<Record<string, unknown>> => {
        if (params.serviceTier !== undefined || !launch.hasServiceTierOverride) return params;
        // Let Codex parse its own CLI overrides and apply their precedence.
        const configured = (await control.readConfig({ cwd, includeLayers: false })).config.service_tier;
        if (typeof configured !== 'string') return params;
        const serviceTier = configured === 'default' ? null : configured === 'fast' ? 'priority' : configured;
        return { ...params, serviceTier };
    };
    control.setServerRequestHandler(() => {});
    // An independent observer preserves settings when a root's side-client
    // reconnects: native resume responses omit collaboration mode.
    const nativeSettings = new Map<string, Record<string, unknown>>();
    control.setNotificationHandler((method, params) => {
        if (method !== 'thread/settings/updated') return;
        const threadId = string(record(params).threadId);
        if (!threadId) return;
        const settings = record(record(params).threadSettings);
        nativeSettings.set(threadId, settings);
        // Never interleave unversioned streams while the root is healthy:
        // an older control packet must not replace a newer root notification.
        const root = roots.get(threadId);
        if (root && !root.client.isInitialized()) root.acceptSettings(settings, false);
    });
    let reconnectingControl = false;
    let controlGeneration = 0;
    const reconnectControl = () => {
        if (stopping) return;
        controlGeneration++;
        if (reconnectingControl) return;
        reconnectingControl = true;
        void (async () => {
            while (!stopping) {
                try {
                    await initializeSharedClient(control);
                    // Roots remain loaded by their independent side-clients.
                    for (const [threadId, root] of roots) {
                        if (root.isActivated && !ending.has(root)) await control.request('thread/resume', { threadId, excludeTurns: true });
                    }
                    return;
                } catch (error) {
                    logger.debug('[Codex shared] control reconnect', error);
                    await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        })().finally(() => { reconnectingControl = false; });
    };

    const shutdown = (error?: unknown): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;
        stopping = true; failure = error;
        if (error) logger.debug('[Codex shared] runtime stopped', error);
        control.setTransportAbandonedHandler(null);
        for (const root of prepared) root.stopAccepting();
        shutdownPromise = (async () => {
            // Close frontend admission first, then drain binding/startup work.
            // No root may materialize after cleanup took its snapshot.
            await gateway?.close().catch(() => {});
            await startup.catch(() => {});
            while (operations.size) await Promise.allSettled([...operations]);
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled([...prepared].filter(root => !ending.has(root)).map(root => root.suspend())),
                    new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })
                ]);
            } finally { clearTimeout(timer); }
            await control.disconnect();
            if (server && server.exitCode === null && server.signalCode === null) {
                if (!await killProcessByChildProcess(server)) throw new Error('Codex engine did not stop; ownership retained for orphan recovery');
            }
            // Release ownership only after the engine is dead, BEFORE inactive
            // reaches the hub. Web may immediately resume through the Runner.
            for (const binding of Object.values(runtime.sessions)) binding.active = false;
            runtime.pendingCreations = [];
            await persist();
        })().catch(error => {
            failure ??= error;
            logger.debug('[Codex shared] shutdown', error);
        }).finally(async () => {
            await Promise.allSettled([...prepared].map(root => root.close(ending.has(root))));
            await rm(sockets, { recursive: true, force: true }).catch(error => logger.debug('[Codex shared] socket cleanup', error));
            finish();
        });
        return shutdownPromise;
    };
    const ownedRoot = (threadId: string): SharedCodexRoot | undefined => roots.get(threadId) ?? retryableBindings.get(threadId)?.root
        ?? [...prepared].find(root => {
            const binding = runtime.sessions[root.session.sessionId];
            return binding?.active && binding.threadId === threadId;
        });
    const endOwnedThread = (root: SharedCodexRoot, threadId: string, nativeArchive: boolean): Promise<unknown> => serializeNativeLifecycle(threadId, async () => {
        if (ownedRoot(threadId) !== root || ending.has(root)) return;
        ending.add(root);
        let result: unknown;
        try {
            if (nativeArchive) {
                // A retained binding may have lost its side connection before
                // activation. Archive the same thread through the live control.
                const client = root.client.isInitialized() ? root.client : control;
                if (!client.isInitialized()) throw new Error('Codex is disconnected; retry archive after reconnect');
                result = await client.request('thread/archive', { threadId });
            }
        } catch (error) { ending.delete(root); throw error; }
        root.stopAccepting();
        roots.delete(threadId);
        retryableBindings.delete(threadId);
        resumingThreads.delete(threadId);
        pendingAdmission.delete(threadId);
        nativeSettings.delete(threadId);
        const binding = runtime.sessions[root.session.sessionId];
        if (binding) binding.active = false;
        await persist();
        // Let the RPC acknowledgement leave both gateway and hub sockets before detach.
        setTimeout(() => {
            void root.close(true).then(async () => {
                prepared.delete(root);
                await notifyRunnerSessionStarted(root.session.sessionId, { ...root.bootstrap.metadata, lifecycleState: 'archived' });
                if (prepared.size === 0 && roots.size === 0 && reservations.size === 0 && retryableBindings.size === 0) await shutdown();
            }).catch(error => logger.debug('[Codex shared] root cleanup', error));
        }, 100);
        return result;
    });
    const end = async (root: SharedCodexRoot, nativeArchive = true): Promise<void> => { await endOwnedThread(root, root.threadId, nativeArchive); };
    const prepare = async (cwd: string, existingSessionId?: string, parent?: SharedCodexRoot): Promise<SharedCodexRoot> => {
        assertRunning();
        // Seed the generated title before Shared Codex replays inherited history.
        // A historical change_title item must not replace this fork identity.
        const forkSummary = parent ? buildForkSessionSummary(parent.session.getMetadata()) : undefined;
        const shared = { flavor: 'codex', startedBy: options.startedBy ?? 'terminal', workingDirectory: cwd,
            exportSessionEnv: false, reportStarted: false, metadataOverrides: {
                ...(forkSummary ? { summary: forkSummary } : {}),
                capabilities: {
                    terminal: true,
                    concurrentClients: true,
                    ...(existingSessionId ? { conversationHistory: undefined } : {})
                },
                ...(parent ? { forkedFrom: parent.session.sessionId } : {})
            }
        } as const;
        // reservedSessionId names one preallocated hub row — single-use. A second
        // create()/fork must mint a fresh row, not re-adopt (#1911 Opus Major).
        const reservedSessionId = takeReservedSessionId(options);
        const bootstrap = existingSessionId
            ? await bootstrapExistingSession({
                ...shared,
                sessionId: existingSessionId,
                requireMetadataFlush: metadata => Boolean(metadata?.capabilities?.conversationHistory)
            })
            : await bootstrapSession({
                ...shared,
                reservedSessionId,
                agentState: { controlledByUser: false },
            });
        const root = new SharedCodexRoot(bootstrap, { directory: join(runtimeDirectory(), 'queues'), generation: id, endpoint: upstream, token: upstreamToken,
            settingsFor: threadId => nativeSettings.get(threadId), startupCatalogConfig, create, end });
        prepared.add(root);
        try { assertRunning(); await root.prepare(); assertRunning(); return root; }
        catch (error) { await root.close(!stopping && !existingSessionId); prepared.delete(root); throw error; }
    };
    const reserveRecord = async (root: SharedCodexRoot, threadId: string) => {
        assertRunning();
        if (roots.has(threadId) || Object.entries(runtime.sessions).some(([sid, binding]) => sid !== root.session.sessionId && binding.active && binding.threadId === threadId)) {
            throw new Error('Thread is already being attached in this runtime; retry after it is ready');
        }
        runtime.sessions[root.session.sessionId] = { threadId, namespace: root.bootstrap.sessionInfo.namespace, active: true };
        runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId); await persist();
    };
    const reserve = async (root: SharedCodexRoot, threadId: string) => withThreadOwnership(home, threadId, id, () => reserveRecord(root, threadId));
    const hasControlSubscription = (reservation: Reservation) =>
        reservation.controlSubscription === controlGeneration && control.isInitialized();
    const holdSavedGoal = async (root: SharedCodexRoot, threadId: string, params: Record<string, unknown>): Promise<ThreadGoal | undefined> => {
        if (params.sandbox != null && params.permissions != null) throw new Error('`permissions` cannot be combined with `sandbox`');
        const goal = await control.getThreadGoal({ threadId }).catch(error => {
            if (!(error instanceof Error) || !/^(?:goals feature is disabled|method not found|unknown method)/i.test(error.message)) throw error;
            // The resume may otherwise load different project flags.
            params.config = { ...record(params.config), 'features.goals': false };
            return { goal: null };
        });
        if (goal.goal?.status !== 'active') return;
        assertRunning();
        // An unloaded goal can be paused without starting its engine.
        const paused = await control.setThreadGoal({ threadId, status: 'paused' });
        if (paused.goal.status !== 'paused') throw new Error('Could not pause the saved Codex goal before tier recovery.');
        root.session.sendSessionEvent({ type: 'message',
            message: 'The saved goal was paused while checking the service tier. Resume the goal when the tier is confirmed.' });
        return paused.goal;
    };
    const restoreRejectedResumeGoal = async (root: SharedCodexRoot, threadId: string, heldGoal: ThreadGoal) => {
        try {
            const signal = AbortSignal.timeout(5_000);
            const { thread } = await control.readThread({ threadId, includeTurns: false }, { signal });
            if (record(record(thread).status).type !== 'notLoaded') return;
            const current = await control.getThreadGoal({ threadId }, { signal });
            if (!isDeepStrictEqual(current.goal, heldGoal) || stopping || ending.has(root) || ownedRoot(threadId) !== root) return;
            const restored = await control.setThreadGoal({ threadId, status: 'active' }, { signal });
            if (restored.goal.status === 'active') root.session.sendSessionEvent({ type: 'message',
                message: 'Codex rejected the resume. The saved goal remains active for the next resume.' });
        } catch (error) {
            logger.debug('[Codex shared] Could not restore the saved goal after resume rejection', error);
        }
    };
    const acceptedResumeParams = async (
        reservation: Reservation, params: Record<string, unknown>, savedThread?: Record<string, unknown>, client = control
    ): Promise<Record<string, unknown>> => {
        const view = rejoinThreadParams(params);
        if (hasControlSubscription(reservation)) return view;
        const root = reservation.root;
        // Without a confirmed live subscription, Codex can load the thread
        // again. Restore HAPI's configuration from the original intent.
        const tier = await resolveUltrafastLaunch(client, 'thread/resume', { ...reservation.executionParams, ...view },
            root.bootstrap.workingDirectory, undefined, savedThread, startupCatalogConfig);
        reservation.tierConfirmationPending = undefined;
        if (tier.ultrafastTarget) reservation.ultrafastTarget = tier.ultrafastTarget;
        if (tier.downgraded) {
            reservation.executionParams = { ...reservation.executionParams, serviceTier: null };
            reservation.downgraded = true;
        }
        const configured = root.config(tier.params);
        if (reservation.resumeId && requiresTierAdmission(root, tier.params.serviceTier, tier.downgraded, reservation.serviceTierExplicit)) {
            pendingAdmission.add(reservation.resumeId);
            await holdSavedGoal(root, reservation.resumeId, configured);
        }
        return configured;
    };
    const bind = async (root: SharedCodexRoot, response: Record<string, unknown>, subscribe: boolean, initialOptions?: SharedLaunchOptions, freshThread = false, serviceTierExplicit?: boolean, ultrafastTarget?: UltrafastTarget, downgraded = false, resume?: Reservation,
        expectedResumeTier = resume?.executionParams.serviceTier, tierDiscoveryFailure?: TierDiscoveryFailure) => {
        assertRunning();
        const threadId = string(record(response.thread).id);
        if (!threadId) throw new Error('Codex lifecycle response has no thread ID');
        const reserved = runtime.sessions[root.session.sessionId];
        if (reserved && reserved.threadId !== threadId) throw new Error('Codex retargeted a reserved thread');
        const assertBindingActive = () => {
            assertRunning();
            const binding = runtime.sessions[root.session.sessionId];
            if (!binding?.active || binding.threadId !== threadId || ownedRoot(threadId) !== root) {
                throw new Error('Codex thread was archived during binding');
            }
        };
        const retryInheritedDiscovery = root.session.getMetadata()?.codexInheritedTierDiscoveryPending === true;
        const requestedUltrafast = !downgraded && ultrafastTarget !== undefined;
        const confirmBeforeInput = tierDiscoveryFailure !== undefined || requiresTierAdmission(root, requestedUltrafast ? 'ultrafast' : expectedResumeTier, downgraded, serviceTierExplicit);
        const explicitTier = serviceTierExplicit ?? root.session.getMetadata()?.codexServiceTierExplicit === true;
        if (resume || confirmBeforeInput) pendingAdmission.add(threadId);
        if (!reserved) await reserve(root, threadId);
        if (ending.has(root)) throw new Error('Codex thread was archived during binding');
        if (!resume?.rootBound) {
            // Native resume needs an empty thread's rollout to be materialized.
            await control.request('thread/metadata/update', { threadId, gitInfo: gitInfo(string(record(response.thread).cwd) ?? root.bootstrap.workingDirectory) });
            assertRunning();
            if (ending.has(root)) throw new Error('Codex thread was archived during binding');
            if (confirmBeforeInput) root.beginTierConfirmation(explicitTier && (requestedUltrafast || downgraded || tierDiscoveryFailure?.kind === 'ultrafast'), ultrafastTarget);
            roots.set(threadId, root);
        } else if (confirmBeforeInput) root.beginTierConfirmation(false, ultrafastTarget);
        if (!resume?.rootBound || subscribe && !root.client.isInitialized()) {
            await root.bind(threadId, response, subscribe, expectedResumeTier, serviceTierExplicit);
            // A new thread starts with zero cumulative usage. Seed once before
            // activation, including when the first bind had to be retried.
            if (freshThread && !resume?.rootBound) root.seedFreshUsage();
            if (resume) resume.rootBound = true;
        } else {
            root.acceptSettings(response, true);
            root.confirmResumeTier(response, expectedResumeTier, serviceTierExplicit);
        }
        assertRunning();
        if (resume?.controlSubscription !== controlGeneration) {
            const generation = controlGeneration;
            await control.request('thread/resume', { threadId, excludeTurns: true });
            if (resume) resume.controlSubscription = generation;
        }
        if (ending.has(root)) throw new Error('Codex thread was archived during binding');
        let tierConfirmationPending = tierDiscoveryFailure !== undefined || (resume?.tierConfirmationPending ?? false);
        if (tierDiscoveryFailure?.kind === 'inherited') root.session.updateMetadata(metadata => ({ ...metadata, codexInheritedTierDiscoveryPending: true }));
        if (tierDiscoveryFailure) {
            const summary = tierDiscoveryFailure.kind === 'ultrafast'
                ? 'The Codex model catalog could not verify Ultrafast.'
                : 'Could not verify the inherited Codex service tier.';
            root.session.sendSessionEvent({ type: 'message', message: [summary, tierDiscoveryFailure.reason,
                'Input is paused. Select a service tier in settings to continue.'].filter(Boolean).join(' ') });
        }
        let standardConfirmed = false;
        if (!tierDiscoveryFailure && resume?.tierConfirmationPending === undefined && (requestedUltrafast || downgraded || retryInheritedDiscovery)) {
            try {
                if (downgraded) { await root.confirmStandardLaunch(explicitTier); standardConfirmed = true; }
                else if (requestedUltrafast) await root.confirmUltrafastLaunch(explicitTier);
                else await root.confirmInheritedTierLaunch(expectedResumeTier);
            }
            catch (error) {
                const targetChanged = error instanceof UltrafastTargetChangedError;
                tierConfirmationPending = retryInheritedDiscovery || targetChanged || downgraded || !root.hasConfirmedStandardTier;
                root.session.sendSessionEvent({ type: 'message', message: targetChanged
                    ? 'The Codex model or provider changed after Ultrafast validation. Input is paused. Select a service tier in settings to continue.'
                    : retryInheritedDiscovery
                        ? 'Could not confirm the inherited Codex service tier. Input is paused. Select a service tier in settings to continue.'
                    : tierConfirmationPending
                        ? 'Ultrafast was not applied and Standard could not be confirmed. Input is paused. Select a service tier in settings to retry on this conversation.'
                        : 'Ultrafast was not applied; Standard is active.' });
                logger.debug('[Codex shared] tier confirmation pending', error);
            }
        }
        assertBindingActive();
        if (resume) {
            resume.tierConfirmationPending = tierConfirmationPending;
            if (!tierConfirmationPending && (requestedUltrafast || downgraded) && root.hasConfirmedStandardTier) {
                resume.executionParams = { ...resume.executionParams, serviceTier: null };
            }
        }
        if (downgraded && standardConfirmed) root.session.sendSessionEvent({ type: 'message', message: ULTRAFAST_FALLBACK_NOTICE });
        await root.activate(initialOptions, serviceTierExplicit, tierConfirmationPending);
        assertBindingActive();
        pendingAdmission.delete(threadId);
        await root.session.flush();
        await persist();
        assertBindingActive();
        // The hub's view of the metadata is what the hub kept of it: a hub
        // without the field strips hostStartMarker, and the runner ignores an
        // untracked runner-started webhook that cannot prove its process
        // generation. The marker therefore comes from the local bootstrap.
        await notifyRunnerSessionStarted(root.session.sessionId, { ...(root.session.getMetadata() ?? root.bootstrap.metadata), hostStartMarker: root.bootstrap.metadata.hostStartMarker });
        assertBindingActive();
    };
    const bindAccepted = async (reservation: Reservation, result: Record<string, unknown>): Promise<void> => {
        const nativeThreadId = string(record(result.thread).id);
        if (!reservation.resumeId && nativeThreadId) {
            reservation.resumeId = nativeThreadId;
            resumingThreads.add(nativeThreadId);
        }
        const threadId = reservation.resumeId;
        try {
            await bind(reservation.root, result, true, reservation.initialOptions, reservation.freshThread,
                reservation.serviceTierExplicit, reservation.ultrafastTarget, reservation.downgraded, threadId ? reservation : undefined);
        } catch (error) {
            if (threadId && threadId === nativeThreadId && !stopping && !ending.has(reservation.root) && !reservation.root.isActivated) {
                retryableBindings.set(threadId, reservation);
                pendingAdmission.add(threadId);
                resumingThreads.delete(threadId);
            } else if (threadId) {
                retryableBindings.delete(threadId);
                if (reservation.root.isActivated) resumingThreads.delete(threadId);
            }
            throw error;
        }
        if (threadId) {
            resumingThreads.delete(threadId);
            retryableBindings.delete(threadId);
        }
    };
    const create = (method: 'thread/start' | 'thread/fork', params: Record<string, unknown>, parent?: SharedCodexRoot, initialOptions?: SharedLaunchOptions, assertAdmission?: () => void): Promise<SharedCodexRoot> => operation(async () => {
        params = nativeTierParams(params);
        const source = method === 'thread/fork'
            ? record(record(await control.request('thread/read', { threadId: params.threadId, includeTurns: false })).thread) : undefined;
        const cwd = string(params.cwd) ?? string(source?.cwd) ?? launch.cwd;
        const root = await prepare(cwd, undefined, parent);
        let nativeDispatched = false;
        let nativeSucceeded = false;
        try {
            runtime.pendingCreations = [...runtime.pendingCreations ?? [], root.session.sessionId]; await persist();
            params = await withNativeLaunchTier(params, cwd);
            const serviceTierExplicit = params.serviceTier !== undefined;
            const resolved = await resolveUltrafastLaunch(control, method, params, cwd, undefined, source, startupCatalogConfig);
            assertRunning();
            const request = root.config({ ...resolved.params, ...(method === 'thread/fork' ? { deferGoalContinuation: true } : {}) });
            if (method === 'thread/fork') parent?.assertForkTierConfirmed();
            assertAdmission?.();
            nativeDispatched = true;
            const response = record(await root.client.request(method, request));
            nativeSucceeded = true;
            const reservation: Reservation = { root, initialOptions, freshThread: method === 'thread/start', executionParams: resolved.params,
                serviceTierExplicit, ultrafastTarget: resolved.ultrafastTarget, downgraded: resolved.downgraded };
            try {
                await bindAccepted(reservation, response);
            } catch (error) {
                const threadId = reservation.resumeId;
                if (!threadId || retryableBindings.get(threadId) !== reservation || resumingThreads.has(threadId) || stopping) throw error;
                // A transient setup failure must not require repeating a Web
                // fork. The native writer already accepted this conversation.
                resumingThreads.add(threadId);
                let result = response;
                // If both subscriptions were lost, restore the original
                // configuration and confirm the tier again before activation.
                if (!root.client.isInitialized() && !hasControlSubscription(reservation)) {
                    try {
                        await initializeSharedClient(root.client);
                        const params = await acceptedResumeParams(reservation, { threadId, excludeTurns: true }, undefined, root.client);
                        result = record(await root.client.request('thread/resume', params));
                    } catch (error) {
                        resumingThreads.delete(threadId);
                        throw error;
                    }
                }
                await bindAccepted(reservation, result);
            }
            return root;
        } catch (error) {
            // A timed-out native mutation may have succeeded. Never replay it or kill unrelated roots.
            if (!nativeSucceeded && (!nativeDispatched || !isIndeterminateError(error))) {
                runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId); await persist();
                prepared.delete(root); await root.close(true);
            }
            else root.session.sendSessionEvent({ type: 'message', message: 'Native thread creation/binding is unconfirmed. Do not retry blindly; inspect the runtime before recovery.' });
            throw error;
        }
    });
    const key = (connection: string, request: Envelope) => `${connection}:${typeof request.id}:${request.id}`;
    const before = (request: Envelope, connection: string): Promise<Envelope> => operation(async () => {
        const params = ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method ?? '') ? nativeTierParams(record(request.params)) : record(request.params);
        if (request.method === 'thread/archive') {
            const threadId = string(params.threadId);
            const owner = threadId ? ownedRoot(threadId) : undefined;
            if (owner && threadId) {
                if (request.id === undefined) throw new Error('Lifecycle operations require a JSON-RPC request ID');
                return { id: request.id, result: await endOwnedThread(owner, threadId, true) ?? {} };
            }
        }
        const queueRoot = roots.get(string(params.threadId) ?? '');
        const queueMutation = ['thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start'].includes(request.method ?? '');
        const initializing = pendingAdmission.has(string(params.threadId) ?? '');
        const tierPending = initializing || queueRoot?.needsTierConfirmation;
        const canCancelQueue = request.method === 'thread/queue/delete' && queueRoot && !initializing;
        // Opening or editing an active goal can immediately start a native turn.
        const goalCanRun = request.method === 'thread/goal/set' && params.status !== 'paused' && params.status !== 'complete';
        if (tierPending && (NATIVE_INPUT_METHODS.has(request.method ?? '') || goalCanRun || queueMutation && !canCancelQueue)) {
            throw new Error('Service tier confirmation is pending. Select a service tier in settings before sending input.');
        }
        if (tierPending && request.method === 'thread/fork') throw new Error('Confirm the service tier in settings before forking this conversation.');
        if (initializing && request.method === 'thread/settings/update') throw new Error('Codex thread initialization is pending. Retry settings when the thread is ready.');
        if (queueRoot && request.method === 'turn/start') {
            if (params.serviceTier === undefined && !((params.model || record(record(params.collaborationMode).settings).model) && queueRoot.hasUltrafastTier)) return request;
            if (request.id === undefined) throw new Error('Turn mutations require a JSON-RPC request ID');
            const resolved = await queueRoot.prepareNativeTurn(params);
            if (queueRoot.needsTierConfirmation || pendingAdmission.has(string(params.threadId) ?? '')) throw new Error('Service tier confirmation is pending. Select a service tier in settings before sending input.');
            nativeTurns.set(key(connection, request), { root: queueRoot, ...resolved, explicitTier: params.serviceTier !== undefined });
            return { ...request, params: resolved.params };
        }
        if (queueRoot && request.method === 'thread/settings/update' && (params.serviceTier !== undefined || params.collaborationMode !== undefined && queueRoot.needsTierConfirmation || (params.model || record(record(params.collaborationMode).settings).model) && queueRoot.hasUltrafastTier)) {
            if (request.id === undefined) throw new Error('Settings mutations require a JSON-RPC request ID');
            await queueRoot.applyNativeSettings(params);
            return { id: request.id, result: {} };
        }
        if (queueRoot && queueMutation) {
            if (request.id === undefined) throw new Error('Queue mutations require a JSON-RPC request ID');
            return { id: request.id, result: await queueRoot.nativeQueueMutation(request.method!, params) };
        }
        if (['thread/revert', 'thread/rollback'].includes(request.method ?? '')) {
            throw new Error('In-place rewind is unavailable with concurrent HAPI clients. Use /fork or Fork at message instead.');
        }
        if (!['thread/start', 'thread/resume', 'thread/fork'].includes(request.method ?? '') || params.ephemeral === true) return request;
        if (request.id === undefined) throw new Error('Lifecycle operations require a JSON-RPC request ID');
        if (params.history || params.path) throw new Error('Use a native thread ID to resume through HAPI');
        const threadId = string(params.threadId);
        const localRoot = threadId ? roots.get(threadId) : undefined;
        if (request.method === 'thread/resume' && threadId && localRoot?.isActivated && !ending.has(localRoot)
            && !resumingThreads.has(threadId) && !retryableBindings.has(threadId)) {
            return { ...request, params: rejoinThreadParams(params) };
        }
        if (request.method === 'thread/resume' && threadId && resumingThreads.has(threadId)) {
            throw new Error('Thread is already being attached in this runtime; retry after it is ready');
        }
        let existing = threadId ? roots.get(threadId) : undefined;
        if (threadId && !existing) {
            let candidate = threadId; const visited = new Set<string>();
            for (;;) {
                if (visited.has(candidate)) throw new Error('Invalid native thread ancestry'); visited.add(candidate);
                await withThreadOwnership(home, candidate, id, async () => {});
                const thread = record(record(await control.request('thread/read', { threadId: candidate, includeTurns: false })).thread);
                const parent = string(thread.parentThreadId);
                if (!parent) break;
                existing = roots.get(parent);
                if (existing) break;
                candidate = parent;
            }
            if (candidate !== threadId && !existing) throw new Error('Resume the parent HAPI session before attaching a child agent');
        }
        const savedThread = threadId && (request.method === 'thread/fork' || request.method === 'thread/resume' && !existing)
            ? record(record(await control.request('thread/read', { threadId, includeTurns: false })).thread) : undefined;
        const cwd = string(params.cwd) ?? string(savedThread?.cwd) ?? existing?.bootstrap.workingDirectory ?? launch.cwd;
        // Actual live changes go through thread/settings/update above.
        if (threadId && request.method !== 'thread/resume') await withThreadOwnership(home, threadId, id, async () => {});
        const claim = request.method === 'thread/resume' && threadId
            ? await withThreadOwnership(home, threadId, id, async () => {
                if (resumingThreads.has(threadId)) throw new Error('Thread is already being attached in this runtime; retry after it is ready');
                const accepted = retryableBindings.get(threadId);
                const live = roots.get(threadId) ?? (existing && roots.get(existing.threadId) === existing ? existing : undefined);
                if (live && !accepted) {
                    if (!live.isActivated || ending.has(live)) throw new Error('Thread is already being attached in this runtime; retry after it is ready');
                    return { root: live, rejoin: true };
                }
                resumingThreads.add(threadId);
                try {
                    if (accepted) return { root: accepted.root, accepted };
                    const root = await prepare(cwd, await findColdBinding(home, threadId));
                    await reserveRecord(root, threadId);
                    return { root };
                } catch (error) { resumingThreads.delete(threadId); throw error; }
            }) : { root: await prepare(cwd, undefined, request.method === 'thread/fork' ? existing : undefined) };
        const { root, accepted } = claim;
        if (claim.rejoin) return { ...request, params: rejoinThreadParams(params) };
        try {
            if (accepted) {
                // Keep the tier intent already checked for this reservation.
                const retainedParams = await acceptedResumeParams(accepted, params, savedThread);
                reservations.set(key(connection, request), accepted);
                return { ...request, params: retainedParams };
            }
            if (request.method !== 'thread/resume') {
                runtime.pendingCreations = [...runtime.pendingCreations ?? [], root.session.sessionId]; await persist();
            }
            const metadata = root.session.getMetadata();
            const resuming = request.method === 'thread/resume';
            const resolved = resuming
                ? await inheritedResumeTier(control, params, metadata?.codexServiceTierExplicit, cwd, metadata?.codexConfirmedServiceTier ?? root.bootstrap.sessionInfo.serviceTier,
                    metadata?.codexPendingServiceTier, metadata?.codexTierConfirmationPending && metadata.codexConfirmedServiceTier === undefined && !metadata.codexInheritedTierDiscoveryPending)
                : await withNativeLaunchTier(params, cwd);
            const tier = await resolveUltrafastLaunch(control, request.method!, resolved, cwd, undefined, savedThread, startupCatalogConfig);
            if (request.method === 'thread/fork') existing?.assertForkTierConfirmed();
            const resumeOverride = params.serviceTier !== undefined || metadata?.codexPendingServiceTier !== undefined;
            const serviceTierExplicit = resuming ? resumeOverride ? true : undefined : resolved.serviceTier !== undefined;
            const configured = root.config({ ...tier.params, ...(request.method === 'thread/fork' ? { deferGoalContinuation: true } : {}) });
            let heldGoal: ThreadGoal | undefined;
            if (request.method === 'thread/resume' && threadId && requiresTierAdmission(root, tier.params.serviceTier, tier.downgraded, serviceTierExplicit)) {
                pendingAdmission.add(threadId);
                heldGoal = await holdSavedGoal(root, threadId, configured);
                assertRunning();
            }
            reservations.set(key(connection, request), { root, resumeId: request.method === 'thread/resume' ? threadId : undefined,
                freshThread: request.method === 'thread/start', executionParams: tier.params,
                serviceTierExplicit,
                ultrafastTarget: tier.ultrafastTarget, downgraded: tier.downgraded, heldGoal });
            return { ...request, params: configured };
        } catch (error) {
            const retained = threadId && retryableBindings.get(threadId)?.root === root;
            if (!retained) await root.close(request.method !== 'thread/resume');
            const binding = runtime.sessions[root.session.sessionId];
            if (binding) binding.active = Boolean(threadId && retryableBindings.has(threadId));
            runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== root.session.sessionId);
            await persist(); if (!retained) prepared.delete(root);
            if (request.method === 'thread/resume' && threadId) {
                resumingThreads.delete(threadId);
                if (!retained) pendingAdmission.delete(threadId);
            }
            throw error;
        }
    });
    const after = (request: Envelope, response: Envelope, connection: string): Promise<void | Envelope[]> => operation(async () => {
        const turn = nativeTurns.get(key(connection, request)); nativeTurns.delete(key(connection, request));
        if (turn && !response.error) {
            // Native acceptance must reach the frontend without waiting for a side-client snapshot.
            void operation(() => turn.root.confirmNativeTurn(
                turn.params, turn.explicitTier, turn.fallbackNotice, turn.generation, turn.inheritedUltrafast, turn.ultrafastTarget, turn.previousTierSelectionRevision))
                .catch(error => logger.debug('[Codex shared] native tier reconciliation', error));
        }
        const reservation = reservations.get(key(connection, request)); reservations.delete(key(connection, request));
        if (reservation) {
            if (response.error) {
                const { root, resumeId, heldGoal } = reservation;
                const retained = resumeId && retryableBindings.get(resumeId)?.root === root;
                const code = record(response.error).code;
                // Native invalid-request/invalid-params replies are definitive.
                // An internal or transport failure may already have loaded the thread.
                if (!retained && resumeId && heldGoal && (code === -32600 || code === -32602)) {
                    await serializeNativeLifecycle(resumeId, () => restoreRejectedResumeGoal(root, resumeId, heldGoal));
                }
                if (!retained) await root.close(!resumeId);
                if (reservation.resumeId && !retryableBindings.has(reservation.resumeId)) pendingAdmission.delete(reservation.resumeId);
                const binding = runtime.sessions[reservation.root.session.sessionId]; if (binding) binding.active = Boolean(reservation.resumeId && retryableBindings.has(reservation.resumeId));
                runtime.pendingCreations = runtime.pendingCreations?.filter(sid => sid !== reservation.root.session.sessionId);
                await persist(); if (!retained) prepared.delete(reservation.root);
                if (reservation.resumeId) resumingThreads.delete(reservation.resumeId);
                return;
            }
            await bindAccepted(reservation, record(response.result));
        } else if (request.method === 'thread/archive' && !response.error) {
            const threadId = string(record(request.params).threadId);
            const root = threadId ? ownedRoot(threadId) : undefined;
            if (root && threadId) await endOwnedThread(root, threadId, false);
        } else if (request.method === 'thread/queue/delete' && !response.error && record(response.result).deleted === true) {
            const root = roots.get(string(record(request.params).threadId) ?? '');
            const nativeId = string(record(request.params).queuedSubmissionId);
            if (root && nativeId) await root.nativeQueueDeleted(nativeId);
        }
        if (!response.error && ['thread/start', 'thread/resume', 'thread/fork'].includes(request.method ?? '')) {
            const threadId = string(record(record(response.result).thread).id);
            // Native 0.154 resume responses omit collaboration mode. Replay
            // the authoritative settings notification after the response so
            // a newly attached TUI doesn't reset a Web-selected Plan mode.
            return roots.get(threadId ?? '')?.replaySettings();
        }
        return undefined;
    });
    const signal = () => { void shutdown(); };
    abortSignal?.addEventListener('abort', signal, { once: true });
    process.on('SIGTERM', signal); process.on('SIGINT', signal); process.on('SIGHUP', signal);
    startup = (async () => {
        if (abortSignal?.aborted) throw new Error('Codex startup canceled');
        assertRunning();
        server = spawn(command.command, [...command.args, 'app-server', ...launch.serverArgs, '--listen', upstream,
            ...(upstreamToken ? ['--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(upstreamToken).digest('hex')] : [])],
            { cwd: launch.cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        server.stderr?.on('data', data => logger.debug('[Codex shared] app-server', data.toString()));
        server.once('error', error => { void shutdown(error); });
        server.once('exit', (code, sig) => { void shutdown(new Error(`app-server exited (${code}, ${sig})`)); });
        runtime.serverPid = server.pid;
        runtime.serverMarker = server.pid ? getProcessStartMarker(server.pid) ?? undefined : undefined;
        if (!runtime.serverPid || !runtime.serverMarker) throw new Error('Cannot verify app-server generation');
        await persist();
        const deadline = Date.now() + 20_000;
        for (;;) {
            try { await initializeSharedClient(control); break; }
            catch (error) { if (Date.now() > deadline || stopping) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        assertRunning();
        // Even provider-scoped model/list can resolve a named provider from
        // startup config while thread/start loads the current provider config.
        if (control.supportsEffectiveUltrafastLaunch()) {
            startupCatalogConfig = (async () => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    return await Promise.race([
                        control.readConfig({ cwd: launch.cwd, includeLayers: true }).then(catalogConfiguration),
                        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5_000); })
                    ]) ?? null;
                } catch {
                    logger.debug('[Codex shared] catalog provider snapshot unavailable');
                    return null;
                } finally { clearTimeout(timer); }
            })();
        }
        assertRunning();
        control.setTransportAbandonedHandler(reconnectControl);
        await checkSharedCapabilities(control);
        assertRunning();
        gateway = await startCodexGateway({ upstream, upstreamToken, path: process.platform === 'win32' ? undefined : join(sockets, 'clients.sock'), token,
            hooks: { before, after, disconnected: connection => {
                for (const [key, turn] of nativeTurns) {
                    if (!key.startsWith(`${connection}:`)) continue;
                    nativeTurns.delete(key);
                    void operation(() => turn.root.recoverLostNativeTurn(turn))
                        .catch(error => logger.debug('[Codex shared] lost turn tier reconciliation', error));
                }
                for (const [key, reservation] of reservations) {
                    if (!key.startsWith(`${connection}:`)) continue;
                    reservation.root.session.sendSessionEvent({ type: 'message', message: 'Native lifecycle outcome is unknown after transport loss. Do not retry blindly; inspect the shared runtime log.' });
                    logger.debug('[Codex shared] quarantined lifecycle reservation', { runtimeId: id, sessionId: reservation.root.session.sessionId });
                }
            }, control: (method, params) => operation(async () => {
                const sid = string(record(params).sessionId);
                const binding = sid ? runtime.sessions[sid] : undefined;
                if (!binding?.active) throw new Error('Shared session not found');
                const { threadId } = binding;
                const root = ownedRoot(threadId);
                if (!root || root.session.sessionId !== sid) throw new Error('Shared session not found');
                if (method === 'hapi/stopSession') {
                    await endOwnedThread(root, threadId, true);
                    if (binding.active) throw new Error('Shared session archive is still in progress');
                    return { stopped: true };
                }
                if (method === 'hapi/attach') {
                    if (roots.get(threadId) === root || retryableBindings.get(threadId)?.root === root) return { threadId };
                    throw new Error('Shared session not found');
                }
                throw new Error('Unknown runtime control');
            }) } });
        if (stopping) { await gateway.close(); assertRunning(); }
        runtime.endpoint = gateway.endpoint; if (process.platform === 'win32') runtime.token = token; await persist();
        let root: SharedCodexRoot;
        if (options.resumeLast) {
            const response = record(await control.request('thread/list', { limit: 1, sortKey: 'updated_at', sortDirection: 'desc',
                ...(!options.resumeAll ? { cwd: launch.cwd } : {}) }));
            options.resumeSessionId = string(record(Array.isArray(response.data) ? response.data[0] : undefined).id);
            if (!options.resumeSessionId) throw new Error('No Codex session to resume');
        }
        if (options.resumeSessionId) {
            const threadId = options.resumeSessionId;
            const thread = record(record(await control.request('thread/read', { threadId, includeTurns: false })).thread);
            if (string(thread.parentThreadId)) {
                throw new Error('Cannot cold-resume a child agent independently. Resume its parent HAPI session instead.');
            }
            // Prove ownership before bootstrap can alter an existing HAPI
            // row's hostPid/metadata. Hold the lock until the reservation is durable.
            root = await withThreadOwnership(home, threadId, id, async () => {
                const existing = options.existingSessionId ?? await findColdBinding(home, threadId);
                const root = await prepare(coldResumeDirectory(options, launch, string(thread.cwd)), existing);
                await reserveRecord(root, threadId); return root;
            });
            const metadata = root.session.getMetadata();
            const explicitParams = await withNativeLaunchTier(launch.threadParams, root.bootstrap.workingDirectory);
            const serviceTierExplicit = explicitParams.serviceTier !== undefined || metadata?.codexPendingServiceTier !== undefined
                ? true : metadata?.codexServiceTierExplicit;
            const cwd = root.bootstrap.workingDirectory;
            let candidate: Record<string, unknown> = { ...explicitParams, cwd };
            let tierDiscoveryFailure: TierDiscoveryFailure | undefined;
            let resolved: Awaited<ReturnType<typeof resolveUltrafastLaunch>>;
            try {
                candidate = await inheritedResumeTier(control, candidate, metadata?.codexServiceTierExplicit, cwd,
                    metadata?.codexConfirmedServiceTier ?? root.bootstrap.sessionInfo.serviceTier, metadata?.codexPendingServiceTier,
                    metadata?.codexTierConfirmationPending && metadata.codexConfirmedServiceTier === undefined && !metadata.codexInheritedTierDiscoveryPending);
                resolved = await resolveUltrafastLaunch(control, 'thread/resume', candidate, cwd, undefined, thread, startupCatalogConfig);
            } catch (error) {
                if (options.startedBy !== 'runner' || !options.existingSessionId) throw error;
                // Bind the existing session without requesting an unverified
                // override. Settings recovery can then confirm Standard.
                logger.debug('[Codex shared] cold resume tier discovery unavailable', error);
                const { serviceTier, ...params } = candidate;
                tierDiscoveryFailure = {
                    kind: serviceTier === 'ultrafast' && serviceTierExplicit === true ? 'ultrafast' : 'inherited',
                    reason: error instanceof CodexTierDiscoveryError ? error.message : undefined
                };
                resolved = { params, downgraded: false };
            }
            const { downgraded } = resolved;
            const params = root.config({ ...resolved.params, threadId, excludeTurns: true });
            const needsTierAdmission = tierDiscoveryFailure !== undefined || requiresTierAdmission(root, resolved.params.serviceTier, downgraded, serviceTierExplicit);
            if (needsTierAdmission) pendingAdmission.add(threadId);
            const response = await serializeNativeLifecycle(threadId, async () => {
                assertRunning();
                if (ownedRoot(threadId) !== root || ending.has(root)) throw new Error('Codex thread was archived during resume');
                const resume = async () => {
                    if (needsTierAdmission) {
                        await holdSavedGoal(root, threadId, params);
                        assertRunning();
                    }
                    return record(await root.client.request('thread/resume', params));
                };
                try {
                    return await resume();
                } catch (error) {
                    // The goal API only finds unarchived rollouts. The binding
                    // may restore its native archive before either operation.
                    if (!options.existingSessionId || !(error instanceof Error)
                        || !(error.message.startsWith(`session ${threadId} is archived.`)
                            || needsTierAdmission && error.message === `thread not found: ${threadId}`)) throw error;
                    await root.client.request('thread/unarchive', { threadId });
                    return resume();
                }
            });
            await bind(root, response, false, options, false, serviceTierExplicit,
                resolved.ultrafastTarget, downgraded, undefined, resolved.params.serviceTier, tierDiscoveryFailure);
        } else root = await create('thread/start', { ...launch.threadParams, cwd: launch.cwd }, undefined, options);
        assertRunning();
        onReady?.({ sessionId: root.session.sessionId, runtime });
    })();
    void startup.catch(error => { if (!stopping) void shutdown(error); });
    if (abortSignal?.aborted) void shutdown();
    try {
        await done;
        if (failure) throw failure;
    } finally {
        abortSignal?.removeEventListener('abort', signal);
        process.off('SIGTERM', signal); process.off('SIGINT', signal); process.off('SIGHUP', signal);
    }
}
