import { describe, expect, it } from 'vitest';
import { shouldIgnoreTerminalEvent } from './terminalEventGuard';

describe('shouldIgnoreTerminalEvent', () => {
    it('ignores terminal events without turn_id when current turn id exists', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: 'turn-1',
            turnInFlight: true
        });

        expect(ignored).toBe(true);
    });

    it('ignores terminal events without turn_id while a turn is still in flight', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: null,
            turnInFlight: true
        });

        expect(ignored).toBe(true);
    });

    it('accepts terminal events without turn_id when anonymous terminal is explicitly allowed', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: null,
            turnInFlight: true,
            allowAnonymousTerminalEvent: true
        });

        expect(ignored).toBe(false);
    });

    it('still ignores terminal events without turn_id when current turn id exists', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: 'turn-1',
            turnInFlight: true,
            allowAnonymousTerminalEvent: true
        });

        expect(ignored).toBe(true);
    });

    it('accepts thread-level terminal events for the current thread when explicitly allowed', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: 'turn-1',
            turnInFlight: true,
            eventThreadId: 'thread-1',
            currentThreadId: 'thread-1',
            allowMatchingThreadIdTerminalEvent: true
        });

        expect(ignored).toBe(false);
    });

    it('ignores thread-level terminal events for a different thread', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: 'turn-1',
            turnInFlight: true,
            eventThreadId: 'thread-old',
            currentThreadId: 'thread-1',
            allowMatchingThreadIdTerminalEvent: true
        });

        expect(ignored).toBe(true);
    });

    it('ignores stale terminal events from another turn', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: 'turn-old',
            currentTurnId: 'turn-current',
            turnInFlight: true
        });

        expect(ignored).toBe(true);
    });

    it('accepts terminal events that match the current turn id', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: 'turn-current',
            currentTurnId: 'turn-current',
            turnInFlight: true
        });

        expect(ignored).toBe(false);
    });

    it('accepts terminal events without turn_id when no turn is active', () => {
        const ignored = shouldIgnoreTerminalEvent({
            eventTurnId: null,
            currentTurnId: null,
            turnInFlight: false
        });

        expect(ignored).toBe(false);
    });
});
