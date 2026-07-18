import { describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { createClaudeLiveAppendQueueHandler, tryLiveAppendQueuedMessage } from './liveAppendQueue';
import type { EnhancedMode } from '../loop';

function createMode(overrides: Partial<EnhancedMode> = {}): EnhancedMode {
    return {
        permissionMode: 'default',
        ...overrides
    };
}

function createQueue(): MessageQueue2<EnhancedMode> {
    return new MessageQueue2<EnhancedMode>((mode) => JSON.stringify({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        effort: mode.effort,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools
    }));
}

describe('tryLiveAppendQueuedMessage', () => {
    it('appends and removes the queued message when the active Claude turn can accept it', () => {
        const queue = createQueue();
        const mode = createMode({ model: 'opus' });
        const activeModeHash = queue.modeHasher(mode);
        const append = vi.fn(() => true);

        queue.push('follow-up while thinking', mode);

        const appended = tryLiveAppendQueuedMessage({
            queue,
            message: 'follow-up while thinking',
            mode,
            activeModeHash,
            thinking: true,
            hasPendingPermission: false,
            append
        });

        expect(appended).toBe(true);
        expect(append).toHaveBeenCalledWith({ message: 'follow-up while thinking', mode });
        expect(queue.size()).toBe(0);
    });

    it('leaves the queued message for the next turn when mode hash differs', () => {
        const queue = createQueue();
        const currentMode = createMode({ model: 'opus' });
        const nextMode = createMode({ model: 'sonnet' });
        const append = vi.fn(() => true);

        queue.push('needs new mode', nextMode);

        const appended = tryLiveAppendQueuedMessage({
            queue,
            message: 'needs new mode',
            mode: nextMode,
            activeModeHash: queue.modeHasher(currentMode),
            thinking: true,
            hasPendingPermission: false,
            append
        });

        expect(appended).toBe(false);
        expect(append).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
    });

    it.each(['/clear', '/compact', '/goal keep working'])('leaves %s queued for isolated processing', (command) => {
        const queue = createQueue();
        const mode = createMode();
        const append = vi.fn(() => true);

        queue.pushIsolateAndClear(command, mode);

        const appended = tryLiveAppendQueuedMessage({
            queue,
            message: command,
            mode,
            activeModeHash: queue.modeHasher(mode),
            thinking: true,
            hasPendingPermission: false,
            append
        });

        expect(appended).toBe(false);
        expect(append).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
    });

    it('leaves the queued message when a permission request is pending', () => {
        const queue = createQueue();
        const mode = createMode();
        const append = vi.fn(() => true);

        queue.push('answer after tool request', mode);

        const appended = tryLiveAppendQueuedMessage({
            queue,
            message: 'answer after tool request',
            mode,
            activeModeHash: queue.modeHasher(mode),
            thinking: true,
            hasPendingPermission: true,
            append
        });

        expect(appended).toBe(false);
        expect(append).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
    });

    it('leaves the queued message when the live append callback rejects it', () => {
        const queue = createQueue();
        const mode = createMode();
        const append = vi.fn(() => false);

        queue.push('late message', mode);

        const appended = tryLiveAppendQueuedMessage({
            queue,
            message: 'late message',
            mode,
            activeModeHash: queue.modeHasher(mode),
            thinking: true,
            hasPendingPermission: false,
            append
        });

        expect(appended).toBe(false);
        expect(append).toHaveBeenCalledWith({ message: 'late message', mode });
        expect(queue.size()).toBe(1);
    });

    it('leaves the queued message while Claude is not thinking', () => {
        const queue = createQueue();
        const mode = createMode();
        const append = vi.fn(() => true);

        queue.push('after result', mode);

        const appended = tryLiveAppendQueuedMessage({
            queue,
            message: 'after result',
            mode,
            activeModeHash: queue.modeHasher(mode),
            thinking: false,
            hasPendingPermission: false,
            append
        });

        expect(appended).toBe(false);
        expect(append).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
    });

    it('builds a MessageQueue2 onMessage handler that reads live launcher state at push time', () => {
        const queue = createQueue();
        const mode = createMode({ model: 'opus' });
        const append = vi.fn(() => true);
        let activeModeHash: string | null = queue.modeHasher(mode);
        let thinking = true;
        let pendingPermission = false;

        queue.setOnMessage(createClaudeLiveAppendQueueHandler({
            queue,
            getActiveModeHash: () => activeModeHash,
            isThinking: () => thinking,
            hasPendingPermission: () => pendingPermission,
            getAppend: () => append
        }));

        queue.push('first live append', mode);
        expect(append).toHaveBeenCalledWith({ message: 'first live append', mode });
        expect(queue.size()).toBe(0);

        thinking = false;
        queue.push('after result', mode);
        expect(queue.size()).toBe(1);

        thinking = true;
        pendingPermission = true;
        queue.push('during permission', mode);
        expect(queue.size()).toBe(2);

        pendingPermission = false;
        activeModeHash = queue.modeHasher(createMode({ model: 'sonnet' }));
        queue.push('different mode', mode);
        expect(queue.size()).toBe(3);
        expect(append).toHaveBeenCalledTimes(1);
    });
    it('does not live-append internal queue injections from unshift', () => {
        const queue = createQueue();
        const mode = createMode({ model: 'opus' });
        const append = vi.fn(() => true);

        queue.setOnMessage(createClaudeLiveAppendQueueHandler({
            queue,
            getActiveModeHash: () => queue.modeHasher(mode),
            isThinking: () => true,
            hasPendingPermission: () => false,
            getAppend: () => append
        }));

        queue.unshift('internal restart prompt', mode);

        expect(append).not.toHaveBeenCalled();
        expect(queue.size()).toBe(1);
    });

    it('removes the exact pushed item when an older duplicate with the same hash is already queued', async () => {
        const queue = createQueue();
        const olderMode = createMode({ permissionMode: 'default', model: 'opus' });
        const liveMode = createMode({ permissionMode: 'bypassPermissions', model: 'opus' });
        const append = vi.fn(() => true);

        queue.push('duplicate text', olderMode);
        queue.setOnMessage(createClaudeLiveAppendQueueHandler({
            queue,
            getActiveModeHash: () => queue.modeHasher(liveMode),
            isThinking: () => true,
            hasPendingPermission: () => false,
            getAppend: () => append
        }));

        queue.push('duplicate text', liveMode);

        expect(append).toHaveBeenCalledWith({ message: 'duplicate text', mode: liveMode });
        expect(queue.size()).toBe(1);

        const remaining = await queue.waitForMessagesAndGetAsString();
        expect(remaining?.message).toBe('duplicate text');
        expect(remaining?.mode.permissionMode).toBe('default');
    });

    it('passes the accepted live-append message and mode to the accepted callback', () => {
        const queue = createQueue();
        const mode = createMode({ model: 'opus' });
        const append = vi.fn(() => true);
        const onAccepted = vi.fn();

        queue.setOnMessage(createClaudeLiveAppendQueueHandler({
            queue,
            getActiveModeHash: () => queue.modeHasher(mode),
            isThinking: () => true,
            hasPendingPermission: () => false,
            getAppend: () => append,
            onAccepted
        }));

        queue.push('accepted callback payload', mode);

        expect(onAccepted).toHaveBeenCalledWith({ message: 'accepted callback payload', mode });
    });

});
