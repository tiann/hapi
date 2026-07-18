import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnershipJournal } from './ownershipJournal';
import {
  ManagedOutcomeMailbox,
  createLaunchSigningMaterial,
  ingestManagedOutcomeSpools,
  readManagedOutcomeSigningContext,
  signManagedOutcome,
  spoolManagedOutcome
} from './managedOutcomeMailbox';

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'hapi-mailbox-'));
  homes.push(home);
  const keys = createLaunchSigningMaterial();
  const journal = await OwnershipJournal.open({ home, writerId: 'owner' });
  await journal.reserveLaunch({
    launchNonce: 'nonce', runnerInstanceId: 'runner', runnerPid: 1, runnerBirthToken: 'r', helperPid: 2,
    helperBirthToken: 'h', bootId: 'b', provider: 'codex', runtimeRealpath: '/hapi', argvNonce: 'nonce',
    launchPublicKey: keys.publicKey, createdAt: new Date().toISOString()
  });
  return { home, keys, journal, mailbox: new ManagedOutcomeMailbox({ home, journal }) };
}

describe('ManagedOutcomeMailbox', () => {
  it('reads launch signing material only from the inherited descriptor binding', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hapi-signing-fd-'));
    homes.push(home);
    const path = join(home, 'context.json');
    const { privateKey } = createLaunchSigningMaterial();
    await writeFile(path, JSON.stringify({ launchNonce: 'nonce', runnerInstanceId: 'runner', privateKey }));
    const fd = openSync(path, 'r');
    const env = {
      HAPI_MANAGED_OUTCOME_FD: String(fd),
      HAPI_LAUNCH_NONCE: 'nonce',
      HAPI_RUNNER_INSTANCE_ID: 'runner'
    } as NodeJS.ProcessEnv;
    expect(readManagedOutcomeSigningContext(env)).toEqual({ launchNonce: 'nonce', runnerInstanceId: 'runner', privateKey });
    expect(env.HAPI_MANAGED_OUTCOME_FD).toBeUndefined();
  });

  it('treats an empty inherited descriptor as recoverable predecessor EOF for an exact managed launch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hapi-signing-eof-'));
    homes.push(home);
    const path = join(home, 'empty-context.json');
    await writeFile(path, '');
    const fd = openSync(path, 'r');
    const env = {
      HAPI_MANAGED_OUTCOME_FD: String(fd),
      HAPI_LAUNCH_NONCE: 'nonce-after-predecessor-crash',
      HAPI_RUNNER_INSTANCE_ID: 'runner-before-crash'
    } as NodeJS.ProcessEnv;

    expect(readManagedOutcomeSigningContext(env)).toBeNull();
    expect(env.HAPI_MANAGED_OUTCOME_FD).toBeUndefined();
  });

  it('fails closed when inherited signing material is nonempty but malformed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hapi-signing-malformed-'));
    homes.push(home);
    const path = join(home, 'malformed-context.json');
    await writeFile(path, '{not-json');
    const fd = openSync(path, 'r');
    const env = {
      HAPI_MANAGED_OUTCOME_FD: String(fd),
      HAPI_LAUNCH_NONCE: 'nonce-malformed',
      HAPI_RUNNER_INSTANCE_ID: 'runner-malformed'
    } as NodeJS.ProcessEnv;

    expect(() => readManagedOutcomeSigningContext(env)).toThrow();
    expect(env.HAPI_MANAGED_OUTCOME_FD).toBeUndefined();
  });

  it('rejects every nonempty signing context with an invalid schema, identity, or Ed25519 key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hapi-signing-invalid-'));
    homes.push(home);
    const { privateKey } = createLaunchSigningMaterial();
    const cases: Array<[string, unknown]> = [
      ['empty-object', {}],
      ['mismatched-identity', {
        launchNonce: 'different-nonce',
        runnerInstanceId: 'runner',
        privateKey
      }],
      ['nonstring-field', {
        launchNonce: 123,
        runnerInstanceId: 'runner',
        privateKey
      }],
      ['invalid-private-key', {
        launchNonce: 'nonce',
        runnerInstanceId: 'runner',
        privateKey: 'not-an-ed25519-private-key'
      }]
    ];

    for (const [name, value] of cases) {
      const path = join(home, `${name}.json`);
      await writeFile(path, JSON.stringify(value));
      const fd = openSync(path, 'r');
      const env = {
        HAPI_MANAGED_OUTCOME_FD: String(fd),
        HAPI_LAUNCH_NONCE: 'nonce',
        HAPI_RUNNER_INSTANCE_ID: 'runner'
      } as NodeJS.ProcessEnv;

      expect(() => readManagedOutcomeSigningContext(env), name).toThrow();
      expect(env.HAPI_MANAGED_OUTCOME_FD, name).toBeUndefined();
    }
  });

  it('verifies Ed25519 outcomes and deduplicates by launch-bound idempotency key', async () => {
    const { keys, journal, mailbox } = await setup();
    const envelope = signManagedOutcome(keys.privateKey, {
      launchNonce: 'nonce', idempotencyKey: 'outcome-1', outcome: { lifecycleState: 'stopped', stoppedBy: 'runner-recycle' }
    });

    await mailbox.ingest(envelope);
    await mailbox.ingest(envelope);
    expect((await journal.snapshot()).outbox).toHaveLength(1);
  });

  it('quarantines a tampered spool without ingesting it', async () => {
    const { home, keys, journal, mailbox } = await setup();
    const envelope = signManagedOutcome(keys.privateKey, {
      launchNonce: 'nonce', idempotencyKey: 'outcome-1', outcome: { lifecycleState: 'stopped' }
    });
    envelope.outcome.lifecycleState = 'running';
    const spool = join(home, 'managed-outbox', 'nonce.jsonl');
    await mkdir(join(home, 'managed-outbox'), { mode: 0o700 });
    await writeFile(spool, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

    const result = await mailbox.ingestSpool(spool);
    expect(result.status).toBe('quarantined');
    expect((await journal.snapshot()).outbox).toHaveLength(0);
    expect(await readFile(result.path!, 'utf8')).toContain('outcome-1');
  });

  it('retains no-session-ID outcomes and flushes them idempotently after registration', async () => {
    const { keys, journal, mailbox } = await setup();
    await mailbox.ingest(signManagedOutcome(keys.privateKey, {
      launchNonce: 'nonce', idempotencyKey: 'outcome-1', outcome: { lifecycleState: 'unhealthy', stopReasonCode: 'ambiguous-turn-delivery' }
    }));
    expect((await journal.snapshot()).launches.nonce.hapiSessionId).toBeUndefined();

    const sent: string[] = [];
    expect(await mailbox.flush(async (item) => { sent.push(item.outcomeId); return { acknowledged: false }; })).toBe(0);
    expect(await mailbox.flush(async (item) => { sent.push(item.outcomeId); return { acknowledged: true }; })).toBe(1);
    expect(sent).toEqual(['outcome-1', 'outcome-1']);
    expect((await journal.snapshot()).outbox).toHaveLength(0);
  });

  it('publishes spools atomically and never accepts a conflicting partial file as durable', async () => {
    const { home, keys } = await setup();
    const envelope = signManagedOutcome(keys.privateKey, {
      launchNonce: 'nonce', idempotencyKey: 'outcome-atomic', outcome: { lifecycleState: 'stopped' }
    });
    const directory = join(home, 'managed-outbox');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'nonce-outcome-atomic.jsonl');
    await writeFile(path, '{partial', { mode: 0o600 });

    await expect(spoolManagedOutcome(home, envelope)).rejects.toThrow('conflicting managed outcome spool')
    await rm(path)
    expect(await spoolManagedOutcome(home, envelope)).toBe(path)
    expect(await spoolManagedOutcome(home, envelope)).toBe(path)
    expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(envelope)}\n`)
  });

  it('ingests a durably published spool after runner restart', async () => {
    const { home, keys, journal } = await setup();
    const envelope = signManagedOutcome(keys.privateKey, {
      launchNonce: 'nonce', idempotencyKey: 'outcome-restart', outcome: { lifecycleState: 'stopped' }
    });
    const path = await spoolManagedOutcome(home, envelope);
    const reopened = new ManagedOutcomeMailbox({ home, journal });

    expect(await reopened.ingestSpool(path)).toEqual({ status: 'ingested', count: 1 });
    expect((await journal.snapshot()).outbox.map((item) => item.outcomeId)).toContain('outcome-restart');
  });

  it('rescans and consumes a child spool while the runner remains alive', async () => {
    const { home, keys, journal, mailbox } = await setup();
    const envelope = signManagedOutcome(keys.privateKey, {
      launchNonce: 'nonce', idempotencyKey: 'outcome-live-rescan', outcome: { lifecycleState: 'stopped' }
    });
    const path = await spoolManagedOutcome(home, envelope);

    expect(await ingestManagedOutcomeSpools(mailbox, join(home, 'managed-outbox'))).toEqual({
      ingested: 1,
      quarantined: 0
    });
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await journal.snapshot()).outbox.map((item) => item.outcomeId)).toContain('outcome-live-rescan');
  });
});
