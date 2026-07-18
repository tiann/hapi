const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_HAPI_HOME = process.env.HAPI_HOME
  ? path.resolve(process.env.HAPI_HOME)
  : path.join(os.homedir(), '.hapi');

function readCliApiToken(settingsPath = path.join(DEFAULT_HAPI_HOME, 'settings.json'), namespace = 'default') {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!settings.cliApiToken || typeof settings.cliApiToken !== 'string') {
    throw new Error(`cliApiToken not found in ${settingsPath}`);
  }
  const raw = settings.cliApiToken.trim();
  if (!raw) throw new Error(`cliApiToken is empty in ${settingsPath}`);
  if (raw.includes(':')) return raw;
  return `${raw}:${namespace}`;
}

module.exports = { DEFAULT_HAPI_HOME, readCliApiToken };
