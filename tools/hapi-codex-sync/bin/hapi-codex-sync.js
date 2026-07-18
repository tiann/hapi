#!/usr/bin/env node
const { main } = require('../src/cli');

main().then((result) => {
  if (result !== undefined) console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
