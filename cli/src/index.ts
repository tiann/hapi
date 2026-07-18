#!/usr/bin/env bun

import { runCli } from './commands/runCli'
import { isRunnerLockHelperInvocation, runRunnerLockHelperInvocation } from './runner/lockHelper'

if (isRunnerLockHelperInvocation()) {
  void runRunnerLockHelperInvocation().then((code) => {
    process.exitCode = code
  })
} else {
  void runCli()
}
