import { describe, expect, it } from 'vitest';
import { describeChildFatalContext } from './childFatalDiagnostics';

const BUN_FATAL_STDERR = 'error: An unknown error occurred (Unexpected)\n';

describe('describeChildFatalContext', () => {
  it('names the low fd limit when the compiled child shows the pre-init fatal signature', () => {
    const message = describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: 10240,
      compiledMode: true
    });

    expect(message).not.toBeNull();
    expect(message!).toContain('10240');
    expect(message!).toContain("RLIMIT_NOFILE");
    expect(message!).toContain('ulimit -n');
  });

  it('mentions the fd variant with the full hint text Bun prints', () => {
    const stderr = [
      'error: An unknown error occurred, possibly due to low max file descriptors (Unexpected)',
      'Current limit: 10240',
      'To fix this, try running:',
      'ulimit -n 2147483646'
    ].join('\n');

    const message = describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: stderr,
      nofileSoftLimit: 10240,
      compiledMode: true
    });

    expect(message).not.toBeNull();
    expect(message!).toContain('10240');
  });

  it('softens the wording in dev mode where only compiled binaries are affected', () => {
    const message = describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: 10240,
      compiledMode: false
    });

    expect(message).not.toBeNull();
    expect(message!).toContain('dev mode');
    expect(message!).not.toContain('ulimit -n 1048576');
  });

  it('rules out the fd limit when the soft limit is comfortable', () => {
    const message = describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: 1048576,
      compiledMode: true
    });

    expect(message).not.toBeNull();
    expect(message!).toContain('1048576');
    expect(message!).toContain('unlikely');
    expect(message!).not.toContain('ulimit -n');
  });

  it('treats a limit at the bump threshold as comfortable', () => {
    const message = describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: 65536,
      compiledMode: true
    });

    expect(message).not.toBeNull();
    expect(message!).toContain('unlikely');
  });

  it('says the fd limit cannot be ruled out when the probe failed', () => {
    const message = describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: Number.NaN,
      compiledMode: true
    });

    expect(message).not.toBeNull();
    expect(message!).toContain('could not be probed');
  });

  it('stays silent for exits that are not the pre-init fatal signature', () => {
    expect(describeChildFatalContext({
      exitCode: 2,
      signal: null,
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: 10240
    })).toBeNull();

    expect(describeChildFatalContext({
      exitCode: null,
      signal: 'SIGKILL',
      stderrTail: BUN_FATAL_STDERR,
      nofileSoftLimit: 10240
    })).toBeNull();

    expect(describeChildFatalContext({
      exitCode: 1,
      signal: null,
      stderrTail: 'error: something went wrong in user code',
      nofileSoftLimit: 10240
    })).toBeNull();

    expect(describeChildFatalContext({
      exitCode: null,
      signal: null,
      stderrTail: '',
      nofileSoftLimit: 10240
    })).toBeNull();
  });
});
