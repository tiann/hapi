import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock
}));

import { captureProcessTableSnapshot } from './processIdentity';

describe('process table snapshot command seam', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('keeps a positive process-table snapshot complete when Linux ps includes PGID zero', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, {
        stdout: [
          '      2       0 [kthreadd]',
          '   4242    4242 /opt/hapi/bin/hapi --hapi-launch-nonce launch-42 --hapi-runner-instance runner-42',
          ''
        ].join('\n'),
        stderr: ''
      });
    });

    await expect(captureProcessTableSnapshot()).resolves.toEqual({
      complete: true,
      rows: [{
        pid: 4242,
        pgid: 4242,
        command: '/opt/hapi/bin/hapi --hapi-launch-nonce launch-42 --hapi-runner-instance runner-42'
      }]
    });
  });
});
