import { defineConfig, type UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-session-purge'

/**
 * Platform module-table words the web shell seeds into every plugin bundle
 * (`packages/client/web/src/seed.ts`). The browser module table resolves a
 * bundle's `require()` against exactly this set plus registered package rows,
 * so these must stay external; any other bare import fails at runtime.
 */
const CLIENT_SEED_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Host half: plain ESM for the Node-side cordis tree. */
const host: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: [/^@deepseek-ai\//, 'react', 'react-dom'],
}

/**
 * Client half: one classic script the browser module system executes, which
 * only REGISTERS a factory (`window.__ModuleLoader__.load`); the module body
 * runs at materialization. ESM output would be a syntax error here.
 */
const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: false,
  external: CLIENT_SEED_EXTERNALS,
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
