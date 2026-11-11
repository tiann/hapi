// Runs the real entry hook, then reports. With `--missing-symbol` the disclaim
// symbol lookup is pointed at a name that does not exist (fail-open check).
import { handleDisclaimExecEntry, takeDisclaimFallbackNote } from '../disclaimExec'
import { loadDarwinSpawnExec } from '../darwinSpawnExec'
import { report } from './report'

const missingSymbol = process.argv.includes('--missing-symbol')
await handleDisclaimExecEntry(missingSymbol
    ? { loadNative: async () => () => loadDarwinSpawnExec({ disclaimSymbol: 'hapi_missing_symbol_for_test' }) }
    : {})
report({ fallbackNote: takeDisclaimFallbackNote() })
