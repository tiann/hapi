/**
 * Stream-json transport for agy: one persistent `agy --input-format
 * stream-json` process per launch config, NDJSON parsing, conversation-DB
 * model and title lookups, and the agy-specific transcript messages.
 *
 * Removal: when agy releases without `agy acp` (< 1.5.0) are no longer
 * supported, delete this directory and its branch in ../agyRemoteLauncher.ts.
 * Nothing else imports from here. Rendering of stored agy transcripts in the
 * web and native apps does not depend on this directory.
 */
export { agyHeadlessDriver as runLegacyStreamJsonAgy } from './agyHeadlessDriver';
