import { defineConfig } from 'tsdown'
export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'runtime-api': 'src/runtime/index.ts', 'auth-api': 'src/auth.ts', 'controller-api': 'src/controller.ts' }, outDir: 'lib', format: 'esm', platform: 'node',
    target: 'node22', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, /^@dataiku\/uv$/, /^ws$/, /^tar$/] },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022',
    dts: false, clean: false, sourcemap: true, deps: { neverBundle: [/^@deepseek-ai\//, /^react($|\/)/, /^react-dom($|\/)/] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "@cqaiclub/cqai-club-smart-home-plugin", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;', footer: 'return module.exports; } });',
    },
  },
])
