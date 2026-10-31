import { describe, expect, it } from 'vitest';
import { observeHeartbeatProcesses } from './heartbeatProcesses';
import { getProcessStartMarker } from '@/utils/process';

describe.skipIf(process.platform !== 'win32')('native Windows heartbeat process query', () => {
    it('observes the current process generation while timers continue running', async () => {
        const marker = getProcessStartMarker(process.pid);
        expect(marker).not.toBeNull();
        let timerServiced = false;
        const timer = setTimeout(() => { timerServiced = true; }, 0);
        try {
            const states = await observeHeartbeatProcesses([process.pid]);
            expect(states.get(process.pid)).toEqual({ alive: true, startMarker: marker });
            expect(timerServiced).toBe(true);
        } finally { clearTimeout(timer); }
    }, 20_000);
});
