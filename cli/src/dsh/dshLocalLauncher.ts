import type { DshSession } from './session';

export async function dshLocalLauncher(
    _session: DshSession,
    _opts: { model?: string }
): Promise<'switch' | 'exit'> {
    throw new Error('DeepSeek Harness 没有本地终端模式，请使用 remote 模式');
}
