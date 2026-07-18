import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runner integration CI contract', () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const validator = resolve(repository, 'cli/scripts/validate-runner-integration-summary.sh');
  const cleanupExitHelper = resolve(repository, 'cli/scripts/runner-integration-exit.sh');

  async function validate(log: string): Promise<ReturnType<typeof spawnSync>> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-runner-ci-contract-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'integration.log');
    await writeFile(path, log);
    return spawnSync('bash', [validator, path], { encoding: 'utf8' });
  }

  it('has the workflow invoke the tested validator under pipefail', async () => {
    const workflow = await readFile(resolve(repository, '.github/workflows/test.yml'), 'utf8');
    const readme = await readFile(resolve(repository, 'cli/src/runner/README.md'), 'utf8');
    const integration = await readFile(resolve(repository, 'cli/src/runner/runner.integration.test.ts'), 'utf8');

    expect(workflow).toContain('set -euo pipefail');
    expect(workflow).toContain('HAPI_RUNNER_INTEGRATION_LEDGER_FILE="$LEDGER_FILE"');
    expect(workflow).toContain('umask 077');
    expect(workflow).toContain('ROOT="$(mktemp -d "$RUNNER_TEMP/hapi-runner-integration.XXXXXX")"');
    expect(workflow).not.toContain('ROOT="$RUNNER_TEMP/hapi-runner-integration"');
    expect(workflow).toContain('mkdir -m 700 "$HUB_HOME" "$CLI_HOME"');
    expect(workflow).toContain('touch "$EVENT_FILE" "$LEDGER_FILE"');
    expect(workflow).toContain('chmod 600 "$EVENT_FILE" "$LEDGER_FILE"');
    expect(workflow).toContain('fixtures/cleanupIntegrationAgents.ts');
    expect(workflow).toContain('source cli/scripts/runner-integration-exit.sh');
    expect(workflow).toContain('hapi_runner_integration_exit "$prior_status" "$fixture_cleanup_status"');
    expect(workflow).toContain('bash cli/scripts/validate-runner-integration-summary.sh "$TEST_LOG"');
    expect(integration).toContain('readFixtureEvents(contract.ledgerFile)');
    expect(readme).not.toMatch(/requires exactly \d+ passing tests/);
    expect(readme).toContain('all collected integration tests to pass');
  });

  it('preserves a main failure and otherwise promotes cleanup failure', () => {
    for (const [mainStatus, cleanupStatus, expected] of [
      [0, 0, 0],
      [0, 1, 1],
      [7, 0, 7],
      [7, 1, 7]
    ] as const) {
      const result = spawnSync('bash', ['-c', [
        `source ${JSON.stringify(cleanupExitHelper)}`,
        `hapi_runner_integration_exit ${mainStatus} ${cleanupStatus}`
      ].join('\n')]);
      expect(result.status, `main=${mainStatus} cleanup=${cleanupStatus}`).toBe(expected);
    }
  });

  it('runs the fixture through production lifecycle handlers instead of manual signal exit', async () => {
    const fixture = await readFile(resolve(repository, 'cli/src/runner/fixtures/integrationAgent.ts'), 'utf8');
    const signalHelper = await readFile(resolve(repository, 'cli/src/runner/fixtures/signalIntegrationAgent.ts'), 'utf8');

    expect(fixture).toContain('lifecycle.registerProcessHandlers()');
    expect(fixture.indexOf('lifecycle.registerProcessHandlers()')).toBeLessThan(
      fixture.indexOf('await bootstrapped.reportStartedToRunner()')
    );
    expect(fixture.indexOf("process.once('SIGTERM'")).toBeLessThan(
      fixture.indexOf('if (webhookDelayMs > 0)')
    );
    expect(fixture).not.toContain('void lifecycle');
    expect(fixture).toContain('HAPI_RUNNER_INTEGRATION_LEDGER_FILE');
    expect(fixture).toContain("event.event === 'process-started'");
    expect(fixture).toContain("processIdentity.evidenceSource !== 'kernel'");
    expect(signalHelper).toContain('waitForExactIntegrationFixtureProcess');
    expect(signalHelper).toContain("process.kill(binding.pid, signal)");
  });

  it('keeps the committed cleanup entrypoint behind the exact test contract', async () => {
    const helper = await readFile(resolve(repository, 'cli/src/runner/fixtures/cleanupIntegrationAgents.ts'), 'utf8');

    expect(helper).toContain("HAPI_RUNNER_INTEGRATION_CLEANUP_HELPER !== '1'");
    expect(helper).toContain('requireRunnerIntegrationContract(process.env)');
    expect(helper).toContain('cleanupIntegrationFixtures({ ledgerFile: contract.ledgerFile })');
    expect(helper).toContain('isCleanIntegrationFixtureCleanup(result)');
    expect(helper).toContain('HAPI_RUNNER_INTEGRATION_EXPECT_TERM_KILL_PID');
    expect(helper).toContain('hasExpectedTermKillReceipt');
  });

  it('runs a real TERM-resistant exact fixture through committed cleanup', async () => {
    const workflow = await readFile(resolve(repository, '.github/workflows/test.yml'), 'utf8');
    const probe = await readFile(resolve(repository, 'cli/src/runner/fixtures/cleanupIntegrationProbe.ts'), 'utf8');

    expect(workflow).toContain('fixtures/cleanupIntegrationProbe.ts');
    expect(workflow).toContain('HAPI_RUNNER_INTEGRATION_EXPECT_TERM_KILL_PID="$CLEANUP_PROBE_PID"');
    expect(workflow).toContain('HAPI_RUNNER_INTEGRATION_CLEANUP_PROBE=1');
    expect(probe).toContain("HAPI_RUNNER_INTEGRATION_CLEANUP_PROBE !== '1'");
    expect(probe).toContain("process.on('SIGTERM'");
    expect(probe).toContain("event: 'process-started'");
    expect(probe).toContain('matchesIntegrationFixtureProcess');
  });

  it('inspects signed outcome receipts only through a read-only isolated Hub database helper', async () => {
    const helper = await readFile(resolve(repository, 'cli/src/runner/fixtures/inspectIntegrationOutcome.ts'), 'utf8');

    expect(helper).toContain("HAPI_RUNNER_INTEGRATION_OUTCOME_INSPECTOR !== '1'");
    expect(helper).toContain('requireRunnerIntegrationContract(process.env)');
    expect(helper).toContain('new Database(contract.hubDbPath, { readonly: true, strict: true })');
    expect(helper).toContain('FROM managed_outcome_idempotency');
  });

  it('accepts only a nonzero all-passing collection with no skipped tests', async () => {
    const valid = await validate('Tests 17 passed (17)\n');
    expect(valid.status, String(valid.stderr)).toBe(0);

    const benignSubstring = await validate([
      'debug: skippingTransientProbe completed',
      'artifact: /tmp/skip-cache/integration.log',
      'Tests 17 passed (17)',
      ''
    ].join('\n'));
    expect(benignSubstring.status, String(benignSubstring.stderr)).toBe(0);

    for (const [name, log] of [
      ['zero collection', 'Tests 0 passed (0)\n'],
      ['partial collection', 'Tests 16 passed (17)\n'],
      ['missing summary', 'runner exited without a summary\n'],
      ['failed pipeline', 'Tests 1 failed | 16 passed (17)\n'],
      ['skipped test', 'Tests 17 passed (17)\n1 skipped\n']
    ] as const) {
      const result = await validate(log);
      expect(result.status, `${name}: ${String(result.stdout)}${String(result.stderr)}`).not.toBe(0);
    }
  });
});
