import { describe, expect, it } from 'vitest';

import { AbortError } from '../sdk/types';
import {
  ClaudeProcessExitError,
  formatClaudeRemoteFailure
} from './remoteFailure';

describe('formatClaudeRemoteFailure', () => {
  it.each([
    'Permission denied for this workspace',
    'Network request failed while contacting the provider',
    'Native resume failed because the session was not found'
  ])('reports an ordinary request failure truthfully: %s', (message) => {
    const formatted = formatClaudeRemoteFailure(new Error(message));

    expect(formatted).toBe(`Claude request failed: ${message}`);
    expect(formatted).not.toContain('Process exited unexpectedly');
  });

  it('keeps user aborts separate from failures', () => {
    expect(formatClaudeRemoteFailure(new AbortError('Claude Code process aborted by user')))
      .toBe('Aborted by user');
  });

  it('uses the process-exit phrase only when code or signal evidence is attached', () => {
    expect(formatClaudeRemoteFailure(new ClaudeProcessExitError({ code: 9, signal: null })))
      .toBe('Process exited unexpectedly (code=9, signal=null)');
    expect(formatClaudeRemoteFailure(new ClaudeProcessExitError({ code: null, signal: 'SIGTERM' })))
      .toBe('Process exited unexpectedly (code=null, signal=SIGTERM)');
    expect(() => new ClaudeProcessExitError({ code: null, signal: null }))
      .toThrow('requires an exit code or signal');
  });
});
