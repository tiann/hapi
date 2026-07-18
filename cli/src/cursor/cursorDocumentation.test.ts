import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function guidePath(name: string): string {
  return fileURLToPath(new URL(`../../../docs/guide/${name}`, import.meta.url));
}

describe('Cursor documentation command consistency', () => {
  it('uses cursor-agent for install, remote, and history commands', async () => {
    const [cursor, installation] = await Promise.all([
      readFile(guidePath('cursor.md'), 'utf8'),
      readFile(guidePath('installation.md'), 'utf8')
    ]);

    expect(cursor).toContain('cursor-agent --version');
    expect(cursor).toContain('`cursor-agent -p`');
    expect(cursor).toContain('`cursor-agent ls`');
    expect(installation).toContain('cursor-agent --version');
    expect(`${cursor}\n${installation}`).not.toMatch(/(^|\n)agent --version(?:\n|$)/);
  });

  it('documents the explicit Cursor command override in troubleshooting', async () => {
    const faq = await readFile(guidePath('faq.md'), 'utf8');

    expect(faq).toContain('cursor-agent');
    expect(faq).toContain('HAPI_CURSOR_PATH');
  });
});
