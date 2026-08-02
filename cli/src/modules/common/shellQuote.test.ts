import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellJoin, windowsCommandQuote } from './shellQuote';

describe('Windows hook command quoting', () => {
    it('quotes executable paths with spaces for cmd /c', () => {
        expect(shellJoin(['C:\\Program Files\\HAPI\\hapi.exe', 'hook-forwarder'], 'win32'))
            .toBe('"C:\\Program Files\\HAPI\\hapi.exe" hook-forwarder');
    });

    it('preserves trailing backslashes and embedded quotes', () => {
        expect(windowsCommandQuote('C:\\path with space\\')).toBe('"C:\\path with space\\\\"');
        expect(windowsCommandQuote('say"hi')).toBe('"say\\"hi"');
    });

    it('fails closed for cmd expansions that cannot be safely quoted', () => {
        expect(() => windowsCommandQuote('C:\\Users\\%USERNAME%\\hapi.exe')).toThrow();
        expect(() => windowsCommandQuote('C:\\Users\\name!\\hapi.exe')).toThrow();
    });

    it.runIf(process.platform === 'win32')('round-trips argv through the documented cmd /c hook shell', () => {
        const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
        const expected = ['space & paren()', 'embedded"quote', 'trailing\\'];
        const command = shellJoin([process.execPath, '-e', script, ...expected], 'win32');
        const output = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
            encoding: 'utf8'
        });
        expect(JSON.parse(output)).toEqual(expected);
    });
});
