import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LunaReserve } from './lunaReserve';
import { withoutCodexModelOverrides } from './appServerConfig';
import type { EnhancedMode } from '../loop';

const threadId = '01900000-0000-7000-8000-000000000001';
const mode: EnhancedMode = { permissionMode: 'yolo', collaborationMode: 'plan', model: 'gpt-5.6', modelReasoningEffort: 'high' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-reserve-'));
    dirs.push(dir);
    const response = {
        accountId: 'account-a', ordinaryUsageAllowed: true as boolean | null,
        rateLimits: { limitId: 'codex', primary: { usedPercent: 40 }, secondary: { usedPercent: 60 }, spendControlReached: false, rateLimitReachedType: null as string | null },
        rateLimitsByLimitId: {
            base_model_inference: { limitId: 'base_model_inference', limitName: 'gpt-reserve', primary: { usedPercent: 10 as unknown, resetsAt: 2000000000, windowDurationMins: 123 }, secondary: { usedPercent: 25 } }
        },
        rateLimitUpsell: null as unknown
    };
    const client = {
        readAccountRateLimits: vi.fn(async () => structuredClone(response) as unknown),
        supportsMethod: vi.fn(async () => true),
        listModels: vi.fn(async () => ({ data: [
            { id: 'gpt-reserve', hidden: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
            { id: 'gpt-5.6', hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
        ] })),
        updateThreadSettings: vi.fn(async () => {})
    };
    const sync = vi.fn(); const publish = vi.fn(); const notice = vi.fn();
    const reserve = new LunaReserve(client, sync, publish, notice, dir);
    await reserve.initialize();
    reserve.attach(threadId, { model: 'gpt-5.6', reasoningEffort: 'high', serviceTier: 'priority' });
    const enter = async () => {
        response.ordinaryUsageAllowed = false;
        response.rateLimitUpsell = { banner_type: 'luna_reserve', blocked_model_slug: 'gpt-5.6' };
        await reserve.refresh(mode, () => true);
    };
    const usage = () => publish.mock.lastCall?.[0];
    return { dir, response, client, reserve, sync, publish, notice, enter, usage };
}

describe('Luna Reserve authoritative transitions', () => {
    it('hides an available bucket and does not infer eligibility from exhausted percentages', async () => {
        const f = await fixture();
        f.response.rateLimits.primary.usedPercent = 100;
        f.response.rateLimits.secondary.usedPercent = 100;
        await f.reserve.refresh(mode, () => true);
        expect(f.usage().reserve).toBeNull();
        expect(f.client.updateThreadSettings).not.toHaveBeenCalled();
        f.response.ordinaryUsageAllowed = false;
        await f.reserve.refresh(mode, () => true);
        expect(f.client.updateThreadSettings).not.toHaveBeenCalled();
    });

    it('activates only after acceptance, separates buckets, preserves return settings, and hides on recovery', async () => {
        const f = await fixture();
        await f.enter();
        expect(f.client.readAccountRateLimits).toHaveBeenLastCalledWith(true);
        expect(f.client.updateThreadSettings).toHaveBeenCalledWith({ threadId, model: 'gpt-reserve', effort: 'medium', serviceTier: null,
            collaborationMode: { mode: 'plan', settings: { model: 'gpt-reserve', reasoning_effort: 'medium', developer_instructions: null } } });
        expect(f.usage().ordinary.secondary.remainingPercent).toBe(40);
        expect(f.usage().reserve.secondary.remainingPercent).toBe(75);
        expect(f.usage().reserve.primary).toEqual({ remainingPercent: 90, resetsAt: 2000000000, windowDurationMins: 123 });
        expect(f.sync).toHaveBeenLastCalledWith('gpt-5.6-luna', 'medium', 'standard');
        expect(JSON.parse(await readFile(join(f.dir, 'tui-luna-reserve', `${threadId}.json`), 'utf8'))).toEqual({ account_id: 'account-a', model: 'gpt-5.6', effort: 'high' });
        expect(f.reserve.turnMode(mode)).toMatchObject({ model: 'gpt-reserve', modelReasoningEffort: 'medium', serviceTier: 'standard' });
        f.response.ordinaryUsageAllowed = true;
        f.response.rateLimitUpsell = null;
        await f.reserve.refresh(mode, () => true);
        expect(f.sync).toHaveBeenLastCalledWith('gpt-5.6', 'high', 'standard');
        expect(f.usage().reserve).toBeNull();
        expect(f.notice).toHaveBeenCalledTimes(2);
    });

    it('retains exhausted Reserve without another switch or retry and treats missing/invalid usage as unknown', async () => {
        const f = await fixture(); await f.enter();
        for (const used of [undefined, null, '50', NaN, Infinity, -1, 101, 100]) {
            f.response.rateLimitsByLimitId.base_model_inference.primary.usedPercent = used;
            await f.reserve.refresh(mode, () => true);
            expect(f.usage().reserve.primary.remainingPercent).toBe(used === 100 ? 0 : null);
        }
        expect(f.client.updateThreadSettings).toHaveBeenCalledTimes(1);
    });

    it('requires a fresh account-bound recovery read; sparse notifications and unknown banners cannot recover', async () => {
        const f = await fixture(); await f.enter();
        f.response.ordinaryUsageAllowed = true;
        f.response.rateLimitUpsell = { banner_type: 'unknown_future_banner' };
        await f.reserve.refresh(mode, () => true);
        f.response.rateLimitUpsell = null;
        f.response.accountId = 'account-b';
        await f.reserve.refresh(mode, () => true);
        expect(f.client.updateThreadSettings).toHaveBeenCalledTimes(1);
        f.response.accountId = 'account-a';
        let finish!: (value: unknown) => void;
        f.client.readAccountRateLimits.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = f.reserve.refresh(mode, () => true);
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        f.reserve.invalidate();
        finish(f.response); await pending;
        expect(f.client.updateThreadSettings).toHaveBeenCalledTimes(1);
    });

    it('reconciles a resumed Reserve task with the TUI return target and ignores another thread settings', async () => {
        const f = await fixture(); await f.enter(); f.reserve.dispose();
        const resumed = new LunaReserve(f.client, f.sync, f.publish, f.notice, f.dir);
        await resumed.initialize();
        resumed.attach(threadId, { model: 'gpt-reserve', reasoningEffort: 'medium' });
        resumed.onSettings('other-thread', { model: 'gpt-5.6', effort: 'high' });
        expect(resumed.turnMode(mode).model).toBe('gpt-reserve');
        f.response.ordinaryUsageAllowed = true; f.response.rateLimitUpsell = null;
        await resumed.refresh(mode, () => true);
        expect(f.sync).toHaveBeenLastCalledWith('gpt-5.6', 'high', 'standard');
        expect(f.usage().reserve).toBeNull();
    });

    it('copies the native fork return target without deleting the parent recovery record', async () => {
        const f = await fixture(); await f.enter();
        const forkId = '01900000-0000-7000-8000-000000000002';
        f.reserve.attach(forkId, { model: 'gpt-reserve', reasoningEffort: 'medium', thread: { forkedFromId: threadId } });
        await f.reserve.refresh(mode, () => true);
        const parent = join(f.dir, 'tui-luna-reserve', `${threadId}.json`);
        const child = join(f.dir, 'tui-luna-reserve', `${forkId}.json`);
        expect(await readFile(child, 'utf8')).toBe(await readFile(parent, 'utf8'));
        f.response.ordinaryUsageAllowed = true; f.response.rateLimitUpsell = null;
        await f.reserve.refresh(mode, () => true);
        expect(f.client.updateThreadSettings).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: forkId, model: 'gpt-5.6' }));
        expect(JSON.parse(await readFile(parent, 'utf8')).model).toBe('gpt-5.6');
        await expect(readFile(child, 'utf8')).rejects.toThrow();
        f.reserve.detach();
        expect(f.usage()).toBeNull();
    });

    it('keeps selection and visibility unchanged on a rejected settings update without looping', async () => {
        const f = await fixture();
        f.client.updateThreadSettings.mockRejectedValue(new Error('Method not found'));
        await f.enter(); await f.reserve.refresh(mode, () => true);
        expect(f.client.updateThreadSettings).toHaveBeenCalledTimes(1);
        expect(f.usage().reserve).toBeNull();
        expect(f.reserve.turnMode(mode).model).toBe('gpt-5.6');
        expect(f.notice).toHaveBeenCalledTimes(1);
    });

    it('does not advertise or activate Reserve on an older protocol', async () => {
        const f = await fixture();
        f.client.readAccountRateLimits.mockImplementation(async () => ({ rateLimits: f.response.rateLimits, accountId: 'account-a', rateLimitUpsell: { banner_type: 'luna_reserve' } }));
        const old = new LunaReserve(f.client, f.sync, f.publish, f.notice, f.dir);
        await old.initialize(); old.attach(threadId, { model: 'gpt-5.6' });
        await old.refresh(mode, () => true);
        expect(f.client.readAccountRateLimits).toHaveBeenLastCalledWith(false);
        expect(f.client.updateThreadSettings).not.toHaveBeenCalled();
    });

    it('waits until idle and hides state after exit/disposal', async () => {
        const f = await fixture();
        f.response.ordinaryUsageAllowed = false; f.response.rateLimitUpsell = { banner_type: 'luna_reserve' };
        await f.reserve.refresh(mode, () => false);
        expect(f.client.updateThreadSettings).not.toHaveBeenCalled();
        await f.enter();
        f.reserve.onSettings(threadId, { model: 'gpt-5.6', effort: 'high' });
        expect(f.usage().reserve).toBeNull();
        f.reserve.dispose();
        expect(f.usage()).toBeNull();
    });

    it('omits model overrides on resume while retaining permissions, tools and instructions', () => {
        expect(withoutCodexModelOverrides({ model: 'stale', serviceTier: 'priority', sandbox: 'workspace-write', config: { model_reasoning_effort: 'high', 'mcp_servers.hapi': {}, developer_instructions: 'hapi' } }))
            .toEqual({ sandbox: 'workspace-write', config: { 'mcp_servers.hapi': {}, developer_instructions: 'hapi' } });
    });
});
