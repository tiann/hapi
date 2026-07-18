import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AcpStdioTransport } from './AcpStdioTransport';

describe('AcpStdioTransport terminal failures', () => {
  it('resolves a pending request from the final stdout record without a newline', async () => {
    const childProgram = [
      "const readline = require('node:readline');",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      "  const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { final: true } });",
      '  process.stdout.write(response, () => process.exit(0));',
      '});'
    ].join('\n');
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', childProgram]
    });

    try {
      await expect(transport.sendRequest('final-record', undefined, { timeoutMs: 2_000 }))
        .resolves.toEqual({ final: true });
    } finally {
      await transport.close();
    }
  });

  it('rejects current and future requests after the child exits and drops later notifications safely', async () => {
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(17)']
    });
    const terminal = vi.fn();
    transport.onTerminal(terminal);
    expect(transport.isOpen()).toBe(true);

    try {
      await expect(transport.sendRequest('request-before-exit', undefined, { timeoutMs: 2_000 }))
        .rejects.toThrow('ACP process exited (code=17, signal=null)');
      expect(transport.isOpen()).toBe(false);
      expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
        message: 'ACP process exited (code=17, signal=null)'
      }));

      await expect(transport.sendRequest('request-after-exit', undefined, { timeoutMs: Number.POSITIVE_INFINITY }))
        .rejects.toThrow('ACP process exited (code=17, signal=null)');

      expect(() => transport.sendNotification('notification-after-exit')).not.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('rejects after a bounded drain when a descendant keeps stdout open', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'hapi-acp-exit-drain-'));
    const descendantDone = join(fixtureDir, 'descendant-done');
    const descendantProgram = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => { writeFileSync(${JSON.stringify(descendantDone)}, 'done'); process.exit(0); }, 5000);`
    ].join('\n');
    const parentProgram = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], {`,
      "  stdio: ['ignore', 'inherit', 'ignore']",
      '});',
      'process.exit(23);'
    ].join('\n');
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', parentProgram],
      exitDrainTimeoutMs: 20
    });

    try {
      await expect(transport.sendRequest('wait-for-exit', undefined, { timeoutMs: Number.POSITIVE_INFINITY }))
        .rejects.toThrow('ACP process exited (code=23, signal=null)');
      expect(existsSync(descendantDone)).toBe(false);
    } finally {
      await transport.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('resolves a final unterminated response during the bounded exit drain', async () => {
    const descendantProgram = 'setTimeout(() => process.exit(0), 1200)';
    const parentProgram = [
      "const readline = require('node:readline');",
      "const { spawn } = require('node:child_process');",
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.once('line', (line) => {",
      '  const request = JSON.parse(line);',
      `  spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], {`,
      "    stdio: ['ignore', 'inherit', 'ignore']",
      '  });',
      "  const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { drained: true } });",
      '  process.stdout.write(response, () => process.exit(0));',
      '});'
    ].join('\n');
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', parentProgram],
      exitDrainTimeoutMs: 20
    });

    try {
      await expect(transport.sendRequest('final-drained-record', undefined, { timeoutMs: 2_000 }))
        .resolves.toEqual({ drained: true });
    } finally {
      await transport.close();
    }
  });

  it('turns a spawn error into one terminal failure for current and future requests', async () => {
    const missingCommand = `hapi-missing-acp-command-${process.pid}-${Date.now()}`;
    const transport = new AcpStdioTransport({ command: missingCommand });

    try {
      await expect(transport.sendRequest('request-during-spawn', undefined, { timeoutMs: 2_000 }))
        .rejects.toThrow(`Failed to spawn ${missingCommand}`);
      await expect(transport.sendRequest('request-after-spawn-error', undefined, { timeoutMs: Number.POSITIVE_INFINITY }))
        .rejects.toThrow(`Failed to spawn ${missingCommand}`);
      expect(() => transport.sendNotification('notification-after-spawn-error')).not.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('rejects pending work when the child closes its stdin pipe', async () => {
    const childProgram = [
      'setInterval(() => {}, 1_000);',
      'setTimeout(() => {',
      "  require('node:fs').closeSync(0);",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');",
      '}, 25);'
    ].join('\n');
    const transport = new AcpStdioTransport({
      command: process.execPath,
      args: ['-e', childProgram]
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ACP stdin-close fixture did not become ready')), 2_000);
        transport.onNotification((method) => {
          if (method !== 'ready') return;
          clearTimeout(timer);
          resolve();
        });
      });

      await expect(transport.sendRequest('request-after-stdin-close', undefined, { timeoutMs: 2_000 }))
        .rejects.toThrow(/ACP stdin failed/);
      await expect(transport.sendRequest('future-request-after-stdin-close', undefined, { timeoutMs: Number.POSITIVE_INFINITY }))
        .rejects.toThrow(/ACP stdin failed/);
      expect(() => transport.sendNotification('notification-after-stdin-close')).not.toThrow();
    } finally {
      await transport.close();
    }
  });
});
