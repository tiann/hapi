import { describe, expect, it, vi } from 'vitest';
import { emitReadyIfIdle } from './readyPolicy';

describe('emitReadyIfIdle', () => {
    it('sends ready only when no input is pending', () => {
        const session = { sendSessionEvent: vi.fn() };

        emitReadyIfIdle(session as never, () => true);
        expect(session.sendSessionEvent).not.toHaveBeenCalled();

        emitReadyIfIdle(session as never, () => false);
        expect(session.sendSessionEvent).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
    });
});
