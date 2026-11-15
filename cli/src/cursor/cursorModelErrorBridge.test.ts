import { describe, expect, it } from 'vitest';
import {
    buildModelErrorBridgePrompt,
    canBridgeModelError,
    mergeBridgeGateFields,
    MODEL_ERROR_BRIDGE_HEADER,
    MAX_LAST_USER_MESSAGE_CHARS,
    truncateLastUserMessage
} from './cursorModelErrorBridge';

describe('buildModelErrorBridgePrompt', () => {
    it('wraps the last user message with bridge context', () => {
        const prompt = buildModelErrorBridgePrompt({
            kind: 'transport_closed',
            rawSnippet: 'WritableIterable is closed',
            lastUserMessage: 'Fix the login bug in auth.ts',
            priorAssistantClaimsDone: false
        });

        expect(prompt).toContain(MODEL_ERROR_BRIDGE_HEADER);
        expect(prompt).toContain('transport_closed: WritableIterable is closed');
        expect(prompt).toContain('Re-sending your last message below.');
        expect(prompt).toContain('---');
        expect(prompt.endsWith('Fix the login bug in auth.ts')).toBe(true);
        expect(prompt).not.toContain('verify what is actually done');
    });

    it('adds completion verification when priorAssistantClaimsDone is true', () => {
        const prompt = buildModelErrorBridgePrompt({
            kind: 'rpc_timeout',
            rawSnippet: 'request timed out after 30000ms',
            lastUserMessage: 'ship the feature',
            priorAssistantClaimsDone: true
        });

        expect(prompt).toContain('verify what is actually done before proceeding.');
    });
});

describe('canBridgeModelError', () => {
    const base = {
        transient: true,
        eventId: 'evt-1000'
    };

    it('allows transient errors that have not been bridged', () => {
        expect(canBridgeModelError(base)).toBe(true);
    });

    it('blocks non-transient errors', () => {
        expect(canBridgeModelError({ ...base, transient: false })).toBe(false);
    });

    it('blocks quota and auth style failures via transient=false', () => {
        expect(canBridgeModelError({
            ...base,
            transient: false
        })).toBe(false);
    });

    it('dedupes when this eventId was already bridged', () => {
        expect(canBridgeModelError({
            ...base,
            bridgedForEventId: 'evt-1000'
        })).toBe(false);
    });

    it('allows a new error after a prior bridge on a different eventId', () => {
        expect(canBridgeModelError({
            ...base,
            eventId: 'evt-2000',
            bridgedForEventId: 'evt-1000'
        })).toBe(true);
    });

    it('blocks when bridge already failed', () => {
        expect(canBridgeModelError({
            ...base,
            retriedAndFailed: true
        })).toBe(false);
    });

    it('blocks when a newer normal turn superseded the error', () => {
        expect(canBridgeModelError({
            ...base,
            supersededByUserTurn: true
        })).toBe(false);
    });

    it('blocks when bridgeable is explicitly false', () => {
        expect(canBridgeModelError({
            ...base,
            bridgeable: false
        })).toBe(false);
    });
});

describe('mergeBridgeGateFields', () => {
    it('keeps prior bridgedForEventId when hub snapshot omits it', () => {
        const merged = mergeBridgeGateFields(
            { bridgedForEventId: 'evt-1000', retriedAndFailed: false },
            { bridgedForEventId: undefined, retriedAndFailed: false }
        );
        expect(merged.bridgedForEventId).toBe('evt-1000');
        expect(canBridgeModelError({
            transient: true,
            eventId: 'evt-1000',
            ...merged
        })).toBe(false);
    });

    it('preserves retriedAndFailed when hub sends false', () => {
        const merged = mergeBridgeGateFields(
            { bridgedForEventId: 'evt-1000', retriedAndFailed: true },
            { bridgedForEventId: undefined, retriedAndFailed: false }
        );
        expect(merged.retriedAndFailed).toBe(true);
    });

    it('preserves supersededByUserTurn when hub omits it', () => {
        const merged = mergeBridgeGateFields(
            { supersededByUserTurn: true },
            { bridgedForEventId: undefined, retriedAndFailed: false, supersededByUserTurn: undefined }
        );
        expect(merged.supersededByUserTurn).toBe(true);
        expect(canBridgeModelError({
            transient: true,
            eventId: 'evt-1000',
            ...merged
        })).toBe(false);
    });
});

describe('truncateLastUserMessage', () => {
    it('passes through short messages unchanged', () => {
        expect(truncateLastUserMessage('hello')).toBe('hello');
    });

    it('caps very long messages', () => {
        const long = 'x'.repeat(40_000);
        expect(truncateLastUserMessage(long).length).toBe(MAX_LAST_USER_MESSAGE_CHARS);
    });
});

describe('MAX_LAST_USER_MESSAGE_CHARS', () => {
    it('is the bridge fail-closed limit', () => {
        expect(MAX_LAST_USER_MESSAGE_CHARS).toBe(32_000);
    });
});
