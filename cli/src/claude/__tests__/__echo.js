const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { process.stdout.write('echo:' + line + '\n'); });
