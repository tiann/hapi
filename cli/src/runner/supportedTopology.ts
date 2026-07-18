import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RunnerEnforcementContext = {
  platform: string;
  supervised: string | undefined;
  parentPid: number;
  currentPid: number;
  currentUid: number;
  hapiHome: string;
  homeDirectory: string;
  execPath: string;
  argv: readonly string[];
  workingDirectory: string;
};

export type RunnerLaunchAgentEvidence = {
  label: string;
  domain: string;
  pid: number | null;
  plistPath: string | null;
  loadedProgramArguments: readonly string[] | null;
  installedLabel: string | null;
  installedProgramArguments: readonly string[] | null;
  installedEnvironmentVariables: {
    HAPI_HOME?: string;
    HAPI_RUNNER_SUPERVISED?: string;
  };
  installedWorkingDirectory: string | null;
  plistOwnerUid: number;
  plistMode: number;
  plistIsRegularFile: boolean;
  plistIsSymbolicLink: boolean;
};

export type RunnerLaunchAgentEvidenceLookup = {
  label: string;
  domain: string;
  plistPath: string;
};

export type RunnerLaunchAgentEvidenceReader = (
  lookup: RunnerLaunchAgentEvidenceLookup,
) => Promise<RunnerLaunchAgentEvidence | null>;

export type RunnerLaunchAgentVerificationReason =
  | 'verified'
  | 'runtime-context-mismatch'
  | 'runtime-arguments-mismatch'
  | 'evidence-unavailable'
  | 'job-identity-mismatch'
  | 'job-pid-mismatch'
  | 'plist-path-mismatch'
  | 'plist-security-mismatch'
  | 'program-arguments-mismatch'
  | 'environment-mismatch'
  | 'working-directory-mismatch';

export type RunnerLaunchAgentVerification = {
  eligible: boolean;
  reason: RunnerLaunchAgentVerificationReason;
  label: string;
  domain: string;
  plistPath: string;
};

export type RunnerLaunchAgentInstallationContext = {
  platform: string;
  currentUid: number;
  hapiHome: string;
  homeDirectory: string;
  expectedPid?: number;
};

type InstalledLaunchAgentPlist = {
  Label?: unknown;
  ProgramArguments?: unknown;
  EnvironmentVariables?: unknown;
  WorkingDirectory?: unknown;
};

function stripLaunchctlValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseLaunchctlScalar(output: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`^\\s*${escapedKey} = (.+)$`, 'm'));
  if (!match?.[1] || match[1].trim() === '{') return null;
  return stripLaunchctlValue(match[1]);
}

function parseLaunchctlArguments(output: string): string[] | null {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === 'arguments = {');
  if (headerIndex < 0) return null;
  const headerIndent = lines[headerIndex]!.search(/\S/);
  const args: string[] = [];

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.search(/\S/);
    if (trimmed === '}' && indent <= headerIndent) break;
    args.push(stripLaunchctlValue(trimmed));
  }

  return args.length > 0 ? args : null;
}

export function parseRunnerLaunchctlPrint(output: string): {
  pid: number | null;
  plistPath: string | null;
  programArguments: string[] | null;
} {
  const rawPid = parseLaunchctlScalar(output, 'pid');
  return {
    pid: rawPid !== null && /^\d+$/.test(rawPid) ? Number(rawPid) : null,
    plistPath: parseLaunchctlScalar(output, 'path'),
    programArguments: parseLaunchctlArguments(output),
  };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null;
  }
  return [...value] as string[];
}

function selectedEnvironment(value: unknown): RunnerLaunchAgentEvidence['installedEnvironmentVariables'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.HAPI_HOME === 'string' ? { HAPI_HOME: record.HAPI_HOME } : {}),
    ...(typeof record.HAPI_RUNNER_SUPERVISED === 'string'
      ? { HAPI_RUNNER_SUPERVISED: record.HAPI_RUNNER_SUPERVISED }
      : {}),
  };
}

export function createRunnerLaunchAgentLabel(hapiHome: string): string {
  const canonicalHome = path.resolve(hapiHome);
  const homeHash = createHash('sha256').update(canonicalHome).digest('hex').slice(0, 12);
  return `run.hapi.runner.${homeHash}`;
}

export async function readRunnerLaunchAgentEvidence(
  lookup: RunnerLaunchAgentEvidenceLookup,
): Promise<RunnerLaunchAgentEvidence | null> {
  try {
    const [plistStat, plistResult, jobResult] = await Promise.all([
      lstat(lookup.plistPath),
      execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', lookup.plistPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync('/bin/launchctl', ['print', `${lookup.domain}/${lookup.label}`], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const installed = JSON.parse(String(plistResult.stdout)) as InstalledLaunchAgentPlist;
    const loaded = parseRunnerLaunchctlPrint(String(jobResult.stdout));

    return {
      label: lookup.label,
      domain: lookup.domain,
      pid: loaded.pid,
      plistPath: loaded.plistPath,
      loadedProgramArguments: loaded.programArguments,
      installedLabel: typeof installed.Label === 'string' ? installed.Label : null,
      installedProgramArguments: stringArray(installed.ProgramArguments),
      installedEnvironmentVariables: selectedEnvironment(installed.EnvironmentVariables),
      installedWorkingDirectory: typeof installed.WorkingDirectory === 'string'
        ? installed.WorkingDirectory
        : null,
      plistOwnerUid: plistStat.uid,
      plistMode: plistStat.mode & 0o777,
      plistIsRegularFile: plistStat.isFile(),
      plistIsSymbolicLink: plistStat.isSymbolicLink(),
    };
  } catch {
    return null;
  }
}

function equalStringArrays(left: readonly string[] | null, right: readonly string[]): boolean {
  return left !== null
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function runtimeArgumentsAreDirect(context: RunnerEnforcementContext): boolean {
  const argv = context.argv;
  if (argv.length !== 3 && argv.length !== 4) return false;
  if (argv.at(-2) !== 'runner' || argv.at(-1) !== 'start-sync') return false;
  if (!path.isAbsolute(argv[0] ?? '') || path.resolve(argv[0]!) !== path.resolve(context.execPath)) return false;
  if (argv.length === 4 && !path.isAbsolute(argv[1] ?? '')) return false;
  return path.isAbsolute(context.hapiHome)
    && path.isAbsolute(context.homeDirectory)
    && path.isAbsolute(context.workingDirectory);
}

function installedArgumentsAreDirect(argv: readonly string[] | null): boolean {
  if (argv === null || (argv.length !== 3 && argv.length !== 4)) return false;
  if (argv.at(-2) !== 'runner' || argv.at(-1) !== 'start-sync') return false;
  if (!path.isAbsolute(argv[0] ?? '')) return false;
  return argv.length !== 4 || path.isAbsolute(argv[1] ?? '');
}

function launchAgentLookup(context: {
  currentUid: number;
  hapiHome: string;
  homeDirectory: string;
}): RunnerLaunchAgentEvidenceLookup {
  const label = createRunnerLaunchAgentLabel(path.resolve(context.hapiHome));
  return {
    label,
    domain: `gui/${context.currentUid}`,
    plistPath: path.join(
      path.resolve(context.homeDirectory),
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    ),
  };
}

function verification(
  eligible: boolean,
  reason: RunnerLaunchAgentVerificationReason,
  lookup: RunnerLaunchAgentEvidenceLookup,
): RunnerLaunchAgentVerification {
  return { eligible, reason, ...lookup };
}

export async function verifyRunnerLaunchAgentIdentity(
  context: RunnerEnforcementContext,
  readEvidence: RunnerLaunchAgentEvidenceReader = readRunnerLaunchAgentEvidence,
): Promise<RunnerLaunchAgentVerification> {
  const canonicalHome = path.resolve(context.hapiHome);
  const lookup = launchAgentLookup(context);
  const { label, domain, plistPath } = lookup;

  if (context.platform !== 'darwin'
    || context.supervised !== 'launchd'
    || context.parentPid !== 1
    || !Number.isSafeInteger(context.currentPid)
    || context.currentPid <= 1
    || !Number.isSafeInteger(context.currentUid)
    || context.currentUid < 0) {
    return verification(false, 'runtime-context-mismatch', lookup);
  }
  if (!runtimeArgumentsAreDirect(context)) {
    return verification(false, 'runtime-arguments-mismatch', lookup);
  }

  const evidence = await readEvidence(lookup).catch(() => null);
  if (!evidence) return verification(false, 'evidence-unavailable', lookup);
  if (evidence.label !== label || evidence.domain !== domain || evidence.installedLabel !== label) {
    return verification(false, 'job-identity-mismatch', lookup);
  }
  if (evidence.pid !== context.currentPid) {
    return verification(false, 'job-pid-mismatch', lookup);
  }
  if (evidence.plistPath !== plistPath) {
    return verification(false, 'plist-path-mismatch', lookup);
  }
  if (!evidence.plistIsRegularFile
    || evidence.plistIsSymbolicLink
    || evidence.plistOwnerUid !== context.currentUid
    || (evidence.plistMode & 0o077) !== 0) {
    return verification(false, 'plist-security-mismatch', lookup);
  }
  if (!equalStringArrays(evidence.loadedProgramArguments, context.argv)
    || !equalStringArrays(evidence.installedProgramArguments, context.argv)) {
    return verification(false, 'program-arguments-mismatch', lookup);
  }
  if (evidence.installedEnvironmentVariables.HAPI_RUNNER_SUPERVISED !== 'launchd'
    || evidence.installedEnvironmentVariables.HAPI_HOME !== canonicalHome) {
    return verification(false, 'environment-mismatch', lookup);
  }
  if (evidence.installedWorkingDirectory !== path.resolve(context.workingDirectory)) {
    return verification(false, 'working-directory-mismatch', lookup);
  }
  return verification(true, 'verified', lookup);
}

export async function verifyConfiguredRunnerLaunchAgentInstallation(
  context: RunnerLaunchAgentInstallationContext,
  readEvidence: RunnerLaunchAgentEvidenceReader = readRunnerLaunchAgentEvidence,
): Promise<RunnerLaunchAgentVerification> {
  const canonicalHome = path.resolve(context.hapiHome);
  const lookup = launchAgentLookup(context);
  const { label, domain, plistPath } = lookup;
  if (context.platform !== 'darwin'
    || !Number.isSafeInteger(context.currentUid)
    || context.currentUid < 0) {
    return verification(false, 'runtime-context-mismatch', lookup);
  }

  const evidence = await readEvidence(lookup).catch(() => null);
  if (!evidence) return verification(false, 'evidence-unavailable', lookup);
  if (evidence.label !== label || evidence.domain !== domain || evidence.installedLabel !== label) {
    return verification(false, 'job-identity-mismatch', lookup);
  }
  if (context.expectedPid !== undefined && evidence.pid !== context.expectedPid) {
    return verification(false, 'job-pid-mismatch', lookup);
  }
  if (evidence.plistPath !== plistPath) {
    return verification(false, 'plist-path-mismatch', lookup);
  }
  if (!evidence.plistIsRegularFile
    || evidence.plistIsSymbolicLink
    || evidence.plistOwnerUid !== context.currentUid
    || (evidence.plistMode & 0o077) !== 0) {
    return verification(false, 'plist-security-mismatch', lookup);
  }
  if (!installedArgumentsAreDirect(evidence.installedProgramArguments)
    || !equalStringArrays(evidence.loadedProgramArguments, evidence.installedProgramArguments ?? [])) {
    return verification(false, 'program-arguments-mismatch', lookup);
  }
  if (evidence.installedEnvironmentVariables.HAPI_RUNNER_SUPERVISED !== 'launchd'
    || evidence.installedEnvironmentVariables.HAPI_HOME !== canonicalHome) {
    return verification(false, 'environment-mismatch', lookup);
  }
  if (evidence.installedWorkingDirectory === null
    || !path.isAbsolute(evidence.installedWorkingDirectory)) {
    return verification(false, 'working-directory-mismatch', lookup);
  }
  return verification(true, 'verified', lookup);
}

export function isRunnerReconciliationEnforcementEnabled(input: {
  configuredMode: 'off' | 'report' | 'enforce';
  killSwitch: boolean;
  preflightEligible: boolean;
  ownershipEligible: boolean;
  launchContextEligible: boolean;
}): boolean {
  return input.configuredMode === 'enforce'
    && !input.killSwitch
    && input.preflightEligible
    && input.ownershipEligible
    && input.launchContextEligible;
}

export function isManagedSpawnAdmissionReady(input: {
  journalHealth?: string;
  hubAvailable: boolean;
}): boolean {
  return input.journalHealth === 'healthy' && input.hubAvailable;
}
