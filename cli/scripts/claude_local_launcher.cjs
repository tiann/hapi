// Disable autoupdater
process.env.DISABLE_AUTOUPDATER = '1';

// Import global Claude Code CLI
const { getClaudeCliPath, runClaudeCli } = require('./claude_version_utils.cjs');

runClaudeCli(getClaudeCliPath());
