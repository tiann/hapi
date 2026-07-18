import { createPrivateKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { closeSync, readFileSync } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { JournalOutcomeItem, ManagedOutcome, OwnershipJournal } from './ownershipJournal';

export interface UnsignedManagedOutcome {
  launchNonce: string;
  idempotencyKey: string;
  outcome: ManagedOutcome;
}

export interface SignedManagedOutcome extends UnsignedManagedOutcome {
  algorithm: 'Ed25519';
  signature: string;
}

export type ManagedOutcomeSigningContext = {
  launchNonce: string;
  runnerInstanceId: string;
  privateKey: string;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function signingBytes(payload: UnsignedManagedOutcome): Buffer {
  return Buffer.from(canonical(payload), 'utf8');
}

export function createLaunchSigningMaterial(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

export function signManagedOutcome(privateKey: string, payload: UnsignedManagedOutcome): SignedManagedOutcome {
  return {
    ...structuredClone(payload),
    algorithm: 'Ed25519',
    signature: sign(null, signingBytes(payload), privateKey).toString('base64')
  };
}

export function verifyManagedOutcome(publicKey: string, envelope: SignedManagedOutcome): boolean {
  if (envelope.algorithm !== 'Ed25519') return false;
  const payload: UnsignedManagedOutcome = {
    launchNonce: envelope.launchNonce,
    idempotencyKey: envelope.idempotencyKey,
    outcome: envelope.outcome
  };
  try {
    return verify(null, signingBytes(payload), publicKey, Buffer.from(envelope.signature, 'base64'));
  } catch {
    return false;
  }
}

export function readManagedOutcomeSigningContext(env: NodeJS.ProcessEnv = process.env): ManagedOutcomeSigningContext | null {
  const rawFd = env.HAPI_MANAGED_OUTCOME_FD;
  delete env.HAPI_MANAGED_OUTCOME_FD;
  if (!rawFd || !/^\d+$/.test(rawFd)) return null;
  const fd = Number(rawFd);
  try {
    const raw = readFileSync(fd, 'utf8');
    if (raw.trim().length === 0) {
      // A predecessor Runner can die after the child inherited the pipe but
      // before it published the private key. EOF is recoverable only for an
      // otherwise exact managed launch; non-managed descriptor misuse remains
      // a hard configuration error and nonempty malformed input still fails
      // closed through JSON.parse below.
      if (env.HAPI_LAUNCH_NONCE && env.HAPI_RUNNER_INSTANCE_ID) return null;
      throw new Error('Managed outcome signing descriptor closed before a managed identity was established');
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Managed outcome signing context has an invalid schema');
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 3
      || keys[0] !== 'launchNonce'
      || keys[1] !== 'privateKey'
      || keys[2] !== 'runnerInstanceId'
      || typeof record.launchNonce !== 'string' || record.launchNonce.length === 0
      || typeof record.runnerInstanceId !== 'string' || record.runnerInstanceId.length === 0
      || typeof record.privateKey !== 'string' || record.privateKey.length === 0) {
      throw new Error('Managed outcome signing context has an invalid schema');
    }
    if (record.launchNonce !== env.HAPI_LAUNCH_NONCE
      || record.runnerInstanceId !== env.HAPI_RUNNER_INSTANCE_ID) {
      throw new Error('Managed outcome signing context identity mismatch');
    }
    try {
      const key = createPrivateKey(record.privateKey);
      if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
        throw new Error('unexpected key type');
      }
    } catch {
      throw new Error('Managed outcome signing context has an invalid Ed25519 private key');
    }
    return {
      launchNonce: record.launchNonce,
      runnerInstanceId: record.runnerInstanceId,
      privateKey: record.privateKey
    };
  } finally {
    try { closeSync(fd); } catch { }
  }
}

export async function spoolManagedOutcome(home: string, envelope: SignedManagedOutcome): Promise<string> {
  const resolvedHome = resolve(home);
  const directory = join(resolvedHome, 'managed-outbox');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const syncDirectory = async (path: string): Promise<void> => {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  // Persist the managed-outbox directory entry itself before callers can
  // treat any child entry as durable.
  await syncDirectory(resolvedHome);
  await syncDirectory(directory);
  const path = join(directory, `${envelope.launchNonce}-${envelope.idempotencyKey}.jsonl`);
  const content = `${JSON.stringify(envelope)}\n`;
  const temporary = join(directory, `.${envelope.launchNonce}-${envelope.idempotencyKey}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing !== content) throw new Error(`conflicting managed outcome spool at ${path}`);
    await syncDirectory(directory);
    return path;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  await syncDirectory(directory);
  return path;
}

export class ManagedOutcomeMailbox {
  private readonly home: string;
  private readonly journal: OwnershipJournal;

  constructor(options: { home: string; journal: OwnershipJournal }) {
    this.home = resolve(options.home);
    this.journal = options.journal;
  }

  async ingest(envelope: SignedManagedOutcome): Promise<void> {
    const snapshot = await this.journal.snapshot();
    const launch = snapshot.launches[envelope.launchNonce];
    if (!launch) throw new Error(`unknown launch ${envelope.launchNonce}`);
    if (!verifyManagedOutcome(launch.launchPublicKey, envelope)) throw new Error('managed outcome signature verification failed');
    await this.journal.appendOutcome(envelope.launchNonce, envelope.outcome, envelope.idempotencyKey);
  }

  async ingestSpool(path: string): Promise<{ status: 'ingested' | 'quarantined'; path?: string; count?: number }> {
    let envelopes: SignedManagedOutcome[];
    try {
      envelopes = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as SignedManagedOutcome);
      const snapshot = await this.journal.snapshot();
      for (const envelope of envelopes) {
        const launch = snapshot.launches[envelope.launchNonce];
        if (!launch || !verifyManagedOutcome(launch.launchPublicKey, envelope)) throw new Error('invalid spool signature');
      }
    } catch {
      const quarantineDir = join(this.home, 'managed-outbox', 'quarantine');
      await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
      const quarantinePath = join(quarantineDir, `${Date.now()}-${path.split('/').pop() ?? 'spool'}.tampered`);
      await rename(path, quarantinePath);
      return { status: 'quarantined', path: quarantinePath };
    }

    for (const envelope of envelopes) await this.ingest(envelope);
    return { status: 'ingested', count: envelopes.length };
  }

  async flush(sender: (item: JournalOutcomeItem) => Promise<{ acknowledged: boolean }>): Promise<number> {
    const items = (await this.journal.snapshot()).outbox;
    let acknowledged = 0;
    for (const item of items) {
      const result = await sender(item);
      if (!result.acknowledged) continue;
      if (await this.journal.acknowledgeOutcome(item.outcomeId)) acknowledged += 1;
    }
    return acknowledged;
  }
}

export async function ingestManagedOutcomeSpools(
  mailbox: ManagedOutcomeMailbox,
  spoolDirectory: string
): Promise<{ ingested: number; quarantined: number }> {
  const names = await readdir(spoolDirectory).catch(() => [] as string[]);
  let ingested = 0;
  let quarantined = 0;
  for (const name of names.filter((entry) => entry.endsWith('.jsonl'))) {
    const path = join(spoolDirectory, name);
    const result = await mailbox.ingestSpool(path);
    if (result.status === 'ingested') {
      ingested += result.count ?? 0;
      await unlink(path).catch(() => undefined);
    } else {
      quarantined += 1;
    }
  }
  return { ingested, quarantined };
}
