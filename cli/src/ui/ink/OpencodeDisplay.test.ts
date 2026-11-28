import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { MessageBuffer } from './messageBuffer';
import { OpencodeDisplay } from './OpencodeDisplay';

describe('remote agent terminal', () => {
    it.each([undefined, 'Cursor'] as const)('renders the correct agent and preloaded model for %s', async (agentName) => {
        const buffer = new MessageBuffer();
        buffer.addMessage('[MODEL:sample[fast=false]]', 'system');
        buffer.addMessage('[MODE:plan]', 'system');
        const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24 });
        const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
        let output = '';
        stdout.on('data', (chunk) => { output += chunk.toString(); });
        const display = render(React.createElement(OpencodeDisplay, { agentName, messageBuffer: buffer }), {
            stdin: stdin as unknown as NodeJS.ReadStream,
            stdout: stdout as unknown as NodeJS.WriteStream,
            debug: true,
            patchConsole: false
        });
        try {
            await vi.waitFor(() => {
                expect(output).toContain(`${agentName ?? 'OpenCode'} Agent Messages`);
                expect(output).toContain(`${agentName ?? 'OpenCode'} running`);
                expect(output).toContain('Model: sample[fast=false] | Permission: plan');
            });
        } finally {
            display.unmount();
            display.cleanup();
        }
    });
});
