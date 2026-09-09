import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/ui/logger';
import type { AgentState } from '@hapi/protocol';
import type { CodexAppServerClient } from '../codexAppServerClient';
import type { EnhancedMode } from '../loop';
import type { ModelListItem, ThreadSettingsUpdateParams } from '../appServerTypes';

// This quota alias belongs only at the Codex boundary, never in HAPI's model picker.
const RESERVE_MODEL = 'gpt-reserve';
const LUNA_MODEL = 'gpt-5.6-luna';
const WindowSchema = z.object({
    usedPercent: z.unknown().optional(),
    windowDurationMins: z.unknown().optional(),
    resetsAt: z.unknown().optional()
});
const BucketSchema = z.object({
    limitId: z.string().nullish(),
    limitName: z.string().nullish(),
    normalModelSlug: z.string().nullish(),
    primary: WindowSchema.nullish(),
    secondary: WindowSchema.nullish(),
    credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean() }).nullish(),
    spendControlReached: z.boolean().nullish(),
    rateLimitReachedType: z.string().nullish()
});
const UsageSchema = z.object({
    accountId: z.string().nullish(),
    ordinaryUsageAllowed: z.boolean().nullish(),
    rateLimits: BucketSchema,
    rateLimitsByLimitId: z.record(z.string(), BucketSchema).nullish(),
    rateLimitUpsell: z.unknown().optional()
});
const BannerSchema = z.object({
    banner_type: z.literal('luna_reserve'),
    blocked_model_slug: z.string().min(1).max(256).nullish()
});
const ReturnSchema = z.object({
    account_id: z.string().min(1),
    model: z.string().min(1).max(256),
    effort: z.string().nullable()
});
const SettingsSchema = z.object({
    model: z.string().min(1),
    effort: z.string().nullish(),
    serviceTier: z.string().nullish()
});
type Usage = z.infer<typeof UsageSchema>;
type Bucket = z.infer<typeof BucketSchema>;
type Settings = z.infer<typeof SettingsSchema>;
type ReserveClient = Pick<CodexAppServerClient, 'readAccountRateLimits' | 'listModels' | 'supportsMethod' | 'updateThreadSettings'>;

function usageBucket(bucket?: Bucket | null): NonNullable<AgentState['codexUsage']>['ordinary'] {
    const window = (value: Bucket['primary']) => {
        if (!value) return null;
        const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
        return {
            remainingPercent: finite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
                ? 100 - value.usedPercent : null,
            windowDurationMins: finite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null,
            resetsAt: finite(value.resetsAt) && value.resetsAt >= 0 ? value.resetsAt : null
        };
    };
    return { primary: window(bucket?.primary), secondary: window(bucket?.secondary) };
}

/** Account reads authorize transitions; settings accepted by the thread establish activation. */
export class LunaReserve {
    private threadId: string | null = null;
    private settings: Settings | null = null;
    private settingsRevision = 0;
    private forkedFrom: string | null = null;
    private snapshot: Usage | null = null;
    private models: ModelListItem[] = [];
    private supported = false;
    private revision = 0;
    private disposed = false;
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly client: ReserveClient,
        private readonly sync: (model: string, effort: string | null, serviceTier: string | null | undefined) => void,
        private readonly publish: (usage: AgentState['codexUsage']) => void,
        private readonly notice: (message: string) => void,
        private readonly codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    ) {}

    async initialize(): Promise<void> {
        this.supported = false;
        this.models = [];
        try {
            const response = UsageSchema.parse(await this.client.readAccountRateLimits());
            this.snapshot = response;
            // Field presence is a protocol capability, not account eligibility.
            if ('ordinaryUsageAllowed' in response && await this.client.supportsMethod('thread/settings/update')) {
                let cursor: string | undefined;
                do {
                    const page = await this.client.listModels({ includeHidden: true, ...(cursor ? { cursor } : {}) });
                    this.models.push(...(page.data ?? []));
                    cursor = page.nextCursor ?? undefined;
                } while (cursor);
                this.supported = this.models.some(model => (model.model ?? model.id) === RESERVE_MODEL);
            }
            this.publishUsage();
        } catch {
            // Older app-servers and API-key accounts can lack the usage endpoint.
            this.publish(null);
        }
    }

    attach(threadId: string, response: unknown, forkedFrom?: string): void {
        const parsed = z.object({ model: z.string(), reasoningEffort: z.string().nullish(), serviceTier: z.string().nullish(), thread: z.object({ forkedFromId: z.string().nullish() }).optional() }).safeParse(response);
        this.threadId = threadId;
        this.forkedFrom = forkedFrom ?? (parsed.success ? parsed.data.thread?.forkedFromId : null) ?? null;
        this.invalidate();
        this.snapshot = null;
        if (parsed.success) {
            this.acceptSettings({ ...parsed.data, effort: parsed.data.reasoningEffort });
        } else {
            this.settings = null;
        }
        this.publishUsage();
    }

    onSettings(threadId: string, value: unknown): void {
        if (threadId !== this.threadId || this.disposed) return;
        const parsed = SettingsSchema.safeParse(value);
        if (!parsed.success) return;
        this.invalidate();
        this.settingsRevision++;
        this.acceptSettings(parsed.data);
        this.publishUsage();
    }

    private acceptSettings(settings: Settings): void {
        this.settings = settings;
        this.sync(settings.model === RESERVE_MODEL ? LUNA_MODEL : settings.model, settings.effort ?? null,
            settings.serviceTier === 'priority' ? 'fast' : settings.serviceTier === null ? 'standard' : undefined);
    }

    invalidate(): void {
        this.revision++;
    }

    detach(): void {
        this.invalidate();
        this.threadId = null;
        this.settings = null;
        this.snapshot = null;
        this.publishUsage();
    }

    dispose(): void {
        this.disposed = true;
        this.invalidate();
        this.publish(null);
    }

    private publishUsage(): void {
        const response = this.snapshot;
        if (!response || this.disposed) {
            this.publish(null);
            return;
        }
        // Never substitute a model-specific bucket for ordinary account windows.
        const ordinary = response.rateLimitsByLimitId?.codex
            ?? (!response.rateLimits.limitId || response.rateLimits.limitId === 'codex' ? response.rateLimits : null);
        const reserve = Object.values(response.rateLimitsByLimitId ?? {}).find(bucket => bucket.limitName === RESERVE_MODEL)
            ?? (response.rateLimits.limitName === RESERVE_MODEL ? response.rateLimits : null);
        this.publish({
            ordinary: usageBucket(ordinary),
            reserve: this.settings?.model === RESERVE_MODEL && response.accountId
                ? usageBucket(reserve) : null
        });
    }

    /** Serialize polling with pre-submission reconciliation; never submit or replay a message here. */
    refresh(mode: EnhancedMode, canSwitch: () => boolean): Promise<void> {
        this.queue = this.queue.then(() => this.readAndReconcile(mode, canSwitch));
        return this.queue;
    }

    private returnPath(threadId = this.threadId): string | null {
        if (!z.string().uuid().safeParse(threadId).success) return null;
        // Shared with the official TUI so local/remote handoff preserves the task's return target.
        return join(this.codexHome, 'tui-luna-reserve', `${threadId}.json`);
    }

    private async loadReturn(threadId = this.threadId): Promise<z.infer<typeof ReturnSchema> | null> {
        const path = this.returnPath(threadId);
        if (!path) return null;
        try {
            const handle = await open(path, 'r');
            try {
                if ((await handle.stat()).size > 4096) return null;
                return ReturnSchema.parse(JSON.parse(await handle.readFile('utf8')));
            } finally {
                await handle.close();
            }
        } catch { return null; }
    }

    private async saveReturn(value: z.infer<typeof ReturnSchema>): Promise<void> {
        const path = this.returnPath();
        if (!path) throw new Error('Invalid Codex thread ID');
        await mkdir(join(this.codexHome, 'tui-luna-reserve'), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(value));
                await handle.sync();
            } finally { await handle.close(); }
            await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
    }

    private async readAndReconcile(mode: EnhancedMode, canSwitch: () => boolean): Promise<void> {
        if (this.disposed) return;
        const revision = this.revision;
        let applying = false;
        try {
            const response = UsageSchema.parse(await this.client.readAccountRateLimits(this.supported));
            if (this.disposed || revision !== this.revision) return;
            this.snapshot = response;
            this.publishUsage();
            if (!this.supported || !this.threadId || !this.settings || !response.accountId || !canSwitch()) return;
            const current = this.settings;
            const inReserve = current.model === RESERVE_MODEL;
            let previous = inReserve ? await this.loadReturn() : null;
            if (inReserve && !previous && this.forkedFrom) {
                const inherited = await this.loadReturn(this.forkedFrom);
                if (inherited?.account_id === response.accountId) {
                    await this.saveReturn(inherited);
                    previous = inherited;
                }
            }
            const ordinary = response.rateLimits;
            const recovered = response.ordinaryUsageAllowed != null
                && (response.ordinaryUsageAllowed || ordinary.credits?.hasCredits || ordinary.credits?.unlimited)
                && response.rateLimitUpsell == null
                && ordinary.spendControlReached !== true && ordinary.rateLimitReachedType == null;
            const banner = BannerSchema.safeParse(response.rateLimitUpsell);
            const entering = !inReserve && (!mode.model || mode.model === current.model)
                && response.ordinaryUsageAllowed === false && banner.success
                && (!banner.data.blocked_model_slug || banner.data.blocked_model_slug === current.model);
            const targetId = entering ? RESERVE_MODEL
                : inReserve && recovered && previous?.account_id === response.accountId ? previous.model : null;
            const target = this.models.find(model => (model.model ?? model.id) === targetId && (entering || model.hidden !== true));
            if (!target || !targetId || revision !== this.revision || !canSwitch()) return;
            const desiredEffort = entering ? current.effort : previous?.effort;
            const effort = target.supportedReasoningEfforts?.some(item => item.reasoningEffort === desiredEffort)
                ? desiredEffort : target.defaultReasoningEffort;
            applying = true;
            if (entering) await this.saveReturn({ account_id: response.accountId, model: current.model, effort: current.effort ?? null });
            if (this.disposed || revision !== this.revision || !canSwitch()) return;
            const params: ThreadSettingsUpdateParams = {
                threadId: this.threadId,
                model: targetId,
                effort: effort ?? null,
                serviceTier: null,
                ...(mode.collaborationMode ? { collaborationMode: {
                    mode: mode.collaborationMode,
                    settings: { model: targetId, reasoning_effort: effort ?? null, developer_instructions: null }
                } } : {})
            };
            const settingsRevision = this.settingsRevision;
            await this.client.updateThreadSettings(params);
            if (this.disposed || params.threadId !== this.threadId) return;
            if (this.settingsRevision !== settingsRevision
                && (this.settings?.model !== targetId || (this.settings.effort ?? null) !== (effort ?? null))) return;
            this.acceptSettings({ model: targetId, effort, serviceTier: null });
            if (!entering) {
                const path = this.returnPath();
                if (path) await rm(path, { force: true }).catch(error => logger.debug('[Codex] Failed to remove Reserve return record', error));
            }
            this.publishUsage();
            this.notice(entering
                ? 'Ordinary Codex usage is exhausted. Switched to GPT-5.6 Luna using Luna Reserve.'
                : `Ordinary Codex usage is available again. Switched back to ${targetId}.`);
        } catch (error) {
            logger.debug('[Codex] Reserve reconciliation unavailable', error);
            if (applying) {
                this.supported = false;
                this.notice('Codex could not apply the Reserve transition. Task settings are unchanged; no message was retried.');
            }
            this.publishUsage();
        }
    }

    turnMode(mode: EnhancedMode): EnhancedMode {
        if (this.settings?.model !== RESERVE_MODEL) return mode;
        const target = this.models.find(model => (model.model ?? model.id) === RESERVE_MODEL);
        const effort = target?.supportedReasoningEfforts?.some(item => item.reasoningEffort === mode.modelReasoningEffort)
            ? mode.modelReasoningEffort : this.settings.effort ?? undefined;
        return { ...mode, model: RESERVE_MODEL, modelReasoningEffort: effort, serviceTier: 'standard' };
    }
}
