const INTERNAL_MANAGED_FLAGS = ['--hapi-launch-nonce', '--hapi-runner-instance'] as const;

export function consumeManagedLaunchArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  delete env.HAPI_LAUNCH_NONCE;
  delete env.HAPI_RUNNER_INSTANCE_ID;
  const values = new Map<string, string[]>();
  const routed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!(INTERNAL_MANAGED_FLAGS as readonly string[]).includes(arg)) {
      routed.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    values.set(arg, [...(values.get(arg) ?? []), value]);
    index += 1;
  }

  const present = INTERNAL_MANAGED_FLAGS.filter((flag) => values.has(flag));
  if (present.length === 0) return routed;
  if (present.length !== INTERNAL_MANAGED_FLAGS.length || present.some((flag) => values.get(flag)!.length !== 1)) {
    throw new Error('managed launch identity flags must appear exactly once as a complete pair');
  }

  env.HAPI_LAUNCH_NONCE = values.get('--hapi-launch-nonce')![0];
  env.HAPI_RUNNER_INSTANCE_ID = values.get('--hapi-runner-instance')![0];
  return routed;
}
