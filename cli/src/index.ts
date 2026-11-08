#!/usr/bin/env bun

import { handleDisclaimExecEntry, takeDisclaimFallbackNote } from './runtime/disclaimExec'

async function main(): Promise<void> {
    // Before the CLI module graph loads: the macOS responsibility re-exec must
    // happen before any module side effects.
    await handleDisclaimExecEntry()
    const fallbackNote = takeDisclaimFallbackNote()
    const { captureLauncherPid } = await import('./runtime/responsibility')
    captureLauncherPid()
    const { runCli } = await import('./commands/runCli')
    if (fallbackNote) {
        const { logger } = await import('./ui/logger')
        logger.debug(`[WARN] [DISCLAIM] ${fallbackNote}`)
    }
    await runCli()
}

void main()
