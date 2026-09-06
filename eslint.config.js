'use strict';

module.exports = [{
  files: ['**/*.js'],
  ignores: ['.homeybuild/**', 'node_modules/**'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: Object.fromEntries(['console', 'URL', 'AbortController', 'Buffer', 'setTimeout', 'clearTimeout', 'setImmediate', '__dirname'].map(name => [name, 'readonly'])),
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'no-unreachable': 'error',
    'no-dupe-args': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-else-if': 'error',
    'no-constant-condition': 'error',
    'valid-typeof': 'error',
  },
}];
