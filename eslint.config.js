import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  { ignores: ['coverage/**', 'node_modules/**', '*.tgz', 'test/.tmp/**', 'docs/screenshots/**'] },
  js.configs.recommended,
  {
    files: ['eslint.config.js', 'lib/**/*.js', 'bin/**/*.mjs', 'test/**/*.{js,mjs}'],
    ignores: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
  {
    // The browser half is a hand-written `__ModuleLoader__` bundle: a classic
    // script that only registers a lazy factory. It must not be parsed as a
    // module, and it runs against browser globals.
    files: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.browser,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
]);
