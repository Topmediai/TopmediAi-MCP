import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await mkdir(new URL('../dist/src/', import.meta.url), { recursive: true });
for (const kind of ['image', 'audio', 'video']) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/ui/${kind}-preview.ts`, import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', charset: 'utf8', minify: true, write: false });
  const template = await readFile(new URL(`../src/ui/${kind}-preview.html`, import.meta.url), 'utf8');
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  await writeFile(new URL(`../dist/src/${kind}-preview.html`, import.meta.url), template.replace(`/* ${kind.toUpperCase()}_PREVIEW_SCRIPT */`, () => script));
}
