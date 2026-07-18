import { execFile } from 'node:child_process';
import { readFile, readlink, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function tokenizeCommand(command: string): string[] {
  return (command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? []).map((token) => {
    const quote = token[0];
    if ((quote === '"' || quote === "'") && token[token.length - 1] === quote) {
      return token.slice(1, -1).replace(/\\([\\"'])/g, '$1');
    }
    return token;
  });
}

export interface ProcessIdentity {
  pid: number;
  uid: number;
  birthToken: string;
  pgid: number;
  executableRealpath: string;
  argv: string[];
  evidenceSource?: 'kernel' | 'ps';
}

export interface ProcessTableRow {
  pid: number;
  pgid: number;
  command: string;
}

export interface ProcessTableSnapshot {
  rows: ProcessTableRow[];
  complete: boolean;
}

export interface ProcessEvidenceSweep {
  findManagedProcessEvidence: (
    launchNonce: string,
    runnerInstanceId: string,
    cap?: number
  ) => Promise<{ matches: ProcessIdentity[]; complete: boolean }>;
  readProcessGroupEvidence: (pgid: number) => Promise<{ members: ProcessIdentity[]; complete: boolean }>;
}

async function canonicalExecutable(executable: string): Promise<string> {
  try {
    return await realpath(executable);
  } catch {
    return executable;
  }
}

function parseNulTerminated(bytes: Uint8Array, start: number, limit: number): { value: string; next: number } {
  let end = start;
  while (end < limit && bytes[end] !== 0) end += 1;
  return { value: new TextDecoder().decode(bytes.subarray(start, end)), next: end + 1 };
}

async function readDarwinKernelIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (typeof Bun === 'undefined') return null;
  const specifier = 'bun:ffi';
  const { dlopen, FFIType, ptr } = await import(specifier) as typeof import('bun:ffi');
  const proc = dlopen('/usr/lib/libproc.dylib', {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 }
  });
  const system = dlopen('/usr/lib/libSystem.B.dylib', {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 }
  });
  try {
    const bsd = new Uint8Array(136);
    if (proc.symbols.proc_pidinfo(pid, 3, 0, ptr(bsd), bsd.length) !== bsd.length) return null;
    const view = new DataView(bsd.buffer, bsd.byteOffset, bsd.byteLength);
    const uid = view.getUint32(20, true);
    const pgid = view.getUint32(100, true);
    const startSeconds = view.getBigUint64(120, true);
    const startMicros = view.getBigUint64(128, true);

    const pathBuffer = new Uint8Array(4096);
    const pathLength = proc.symbols.proc_pidpath(pid, ptr(pathBuffer), pathBuffer.length);
    if (pathLength <= 0) return null;
    const executable = new TextDecoder().decode(pathBuffer.subarray(0, pathLength));

    const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2, pid
    const size = new BigUint64Array(1);
    if (system.symbols.sysctl(ptr(mib), 3, 0, ptr(size), 0, 0) !== 0 || size[0] <= 4n) return null;
    const bytes = new Uint8Array(Number(size[0]));
    if (system.symbols.sysctl(ptr(mib), 3, ptr(bytes), ptr(size), 0, 0) !== 0) return null;
    const argc = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
    if (argc <= 0 || argc > 4096) return null;
    let cursor = parseNulTerminated(bytes, 4, bytes.length).next;
    while (cursor < bytes.length && bytes[cursor] === 0) cursor += 1;
    const argv: string[] = [];
    for (let index = 0; index < argc && cursor < bytes.length; index += 1) {
      const parsed = parseNulTerminated(bytes, cursor, bytes.length);
      argv.push(parsed.value);
      cursor = parsed.next;
    }
    if (argv.length !== argc || argv.some((value) => value.length === 0)) return null;
    return {
      pid,
      uid,
      pgid,
      birthToken: `darwin:${startSeconds}:${startMicros}`,
      executableRealpath: await canonicalExecutable(executable),
      argv,
      evidenceSource: 'kernel'
    };
  } finally {
    proc.close();
    system.close();
  }
}

async function readLinuxKernelIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const [stat, status, cmdline, executable] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`),
      readlink(`/proc/${pid}/exe`)
    ]);
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]); // field 5 overall; fields begins at field 3
    const startTicks = fields[19]; // field 22 overall
    const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
    const argv = cmdline.toString('utf8').split('\0').filter(Boolean);
    if (!Number.isInteger(pgid) || !Number.isInteger(uid) || !startTicks || argv.length === 0) return null;
    return {
      pid,
      uid,
      pgid,
      birthToken: `linux:${startTicks}`,
      executableRealpath: await canonicalExecutable(executable),
      argv,
      evidenceSource: 'kernel'
    };
  } catch {
    return null;
  }
}

async function readPsFallback(pid: number): Promise<ProcessIdentity | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', [
      '-ww', '-p', String(pid), '-o', 'uid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'command='
    ], { encoding: 'utf8' });
    const match = stdout.trimEnd().match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/);
    if (!match) return null;
    const uid = Number(match[1]);
    const pgid = Number(match[2]);
    const argv = tokenizeCommand(match[5]);
    if (!Number.isInteger(uid) || !Number.isInteger(pgid) || argv.length === 0) return null;
    return {
      pid,
      uid,
      pgid,
      birthToken: `ps:${match[3].trim().replace(/\s+/g, ' ')}`,
      executableRealpath: await canonicalExecutable(argv[0]?.startsWith('/') ? argv[0] : match[4]),
      argv,
      evidenceSource: 'ps'
    };
  } catch {
    return null;
  }
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'darwin') return await readDarwinKernelIdentity(pid) ?? await readPsFallback(pid);
  if (process.platform === 'linux') return await readLinuxKernelIdentity(pid);
  return null;
}

export async function listProcessGroup(pgid: number): Promise<ProcessIdentity[]> {
  return (await readProcessGroupEvidence(pgid)).members;
}

export function parseProcessTableSnapshot(stdout: string): ProcessTableSnapshot {
  const rows: ProcessTableRow[] = [];
  let complete = true;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!match) {
      complete = false;
      continue;
    }
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid)) {
      complete = false;
      continue;
    }
    // Linux exposes kernel threads such as kthreadd with process group 0.
    // They can never belong to a managed positive process group, but are valid
    // ps rows and must not poison completeness for every unrelated query.
    if (pgid === 0) continue;
    rows.push({ pid, pgid, command: match[3] });
  }
  return { rows, complete };
}

export async function captureProcessTableSnapshot(): Promise<ProcessTableSnapshot> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', [
      '-axww', '-o', 'pid=', '-o', 'pgid=', '-o', 'command='
    ], { encoding: 'utf8' });
    return parseProcessTableSnapshot(stdout);
  } catch {
    return { rows: [], complete: false };
  }
}

export async function createProcessEvidenceSweep(options: {
  captureSnapshot?: () => Promise<ProcessTableSnapshot>;
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
} = {}): Promise<ProcessEvidenceSweep> {
  const snapshot = await (options.captureSnapshot ?? captureProcessTableSnapshot)();
  const readIdentity = options.readIdentity ?? readProcessIdentity;
  const identityCache = new Map<number, Promise<ProcessIdentity | null>>();
  const identityFor = async (pid: number): Promise<ProcessIdentity | null> => {
    let pending = identityCache.get(pid);
    if (!pending) {
      pending = readIdentity(pid);
      identityCache.set(pid, pending);
    }
    return await pending;
  };

  return {
    findManagedProcessEvidence: async (launchNonce, runnerInstanceId, cap = 3) => {
      let complete = snapshot.complete;
      const candidates = snapshot.rows.filter((row) => (
        row.command.includes(launchNonce) && row.command.includes(runnerInstanceId)
      ));
      const matches: ProcessIdentity[] = [];
      for (const row of candidates) {
        const identity = await identityFor(row.pid);
        if (!identity || identity.evidenceSource === 'ps' || identity.pgid !== row.pgid) {
          complete = false;
          continue;
        }
        const has = (flag: string, value: string) => identity.argv.some((item, index) => (
          item === flag && identity.argv[index + 1] === value
        ));
        if (has('--hapi-launch-nonce', launchNonce)
          && has('--hapi-runner-instance', runnerInstanceId)) {
          matches.push(identity);
        }
      }
      return {
        matches: matches.length > cap ? matches.slice(0, cap + 1) : matches,
        complete
      };
    },
    readProcessGroupEvidence: async (pgid) => {
      if (!Number.isInteger(pgid) || pgid <= 0) return { members: [], complete: false };
      let complete = snapshot.complete;
      const members: ProcessIdentity[] = [];
      for (const row of snapshot.rows.filter((candidate) => candidate.pgid === pgid)) {
        const identity = await identityFor(row.pid);
        if (!identity || identity.pgid !== pgid) {
          complete = false;
          continue;
        }
        members.push(identity);
      }
      return { members, complete };
    }
  };
}

export async function readProcessGroupEvidence(pgid: number): Promise<{ members: ProcessIdentity[]; complete: boolean }> {
  const sweep = await createProcessEvidenceSweep();
  return await sweep.readProcessGroupEvidence(pgid);
}

export function isCompleteOwnedProcessGroup(
  leader: ProcessIdentity,
  evidence: { members: ProcessIdentity[]; complete: boolean }
): boolean {
  if (!evidence.complete) return false;
  const containsLeader = evidence.members.some((member) =>
    member.pid === leader.pid
    && member.birthToken === leader.birthToken
    && member.pgid === leader.pgid
    && member.uid === leader.uid
  );
  return containsLeader && evidence.members.every((member) =>
    member.evidenceSource !== 'ps'
    && member.pgid === leader.pgid
    && member.uid === leader.uid
  );
}

export async function findManagedProcesses(launchNonce: string, runnerInstanceId: string, cap = 3): Promise<ProcessIdentity[]> {
  return (await findManagedProcessEvidence(launchNonce, runnerInstanceId, cap)).matches;
}

export async function findManagedProcessEvidence(
  launchNonce: string,
  runnerInstanceId: string,
  cap = 3
): Promise<{ matches: ProcessIdentity[]; complete: boolean }> {
  const sweep = await createProcessEvidenceSweep();
  return await sweep.findManagedProcessEvidence(launchNonce, runnerInstanceId, cap);
}
