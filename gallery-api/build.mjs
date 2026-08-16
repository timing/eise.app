import { build } from 'esbuild';
import { builtinModules } from 'node:module';

const external = [...builtinModules, ...builtinModules.map(m => `node:${m}`)];

await build({
  entryPoints: ['./src/bunny.js'],
  outfile: './dist/bundle.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  packages: 'bundle',
  external,
  minify: true,
  logLevel: 'info',
  banner: {
    js: `import * as process from "node:process"; globalThis.process ??= process;`,
  },
});
