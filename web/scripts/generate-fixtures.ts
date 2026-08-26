// Regenerates shared/fixtures/** from the web chat pipeline (the source of
// truth). Run from the repo root with `bun run gen:fixtures`, or directly:
// `cd web && bun scripts/generate-fixtures.ts`. Output is byte-deterministic.
import { generateAllFixtures } from './fixtures/generate'

await generateAllFixtures()
