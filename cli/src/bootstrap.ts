// Disable Ink devtools in compiled binaries to avoid optional dependencies.
process.env.DEV = 'false';

await import('./index');
