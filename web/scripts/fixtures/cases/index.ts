import type { FixtureCase } from '../fixtureTypes'
import { claudeOutputCases } from './claudeOutput'
import { codexCases } from './codex'
import { eventCases } from './events'
import { userCases } from './user'
import { truncationCases } from './truncation'
import { permissionCases } from './permissions'
import { toolGroupCases } from './toolGroups'
import { sidechainCases } from './sidechain'
import { cliOutputCases } from './cliOutput'
import { agyCases } from './agy'
import { cursorCases } from './cursor'

/** Batches 1 + 2. Each case becomes shared/fixtures/chat/<name>.json. */
export const fixtureCases: FixtureCase[] = [
    ...claudeOutputCases,
    ...codexCases,
    ...eventCases,
    ...userCases,
    ...truncationCases,
    ...permissionCases,
    ...toolGroupCases,
    ...sidechainCases,
    ...cliOutputCases,
    ...agyCases,
    ...cursorCases
]
