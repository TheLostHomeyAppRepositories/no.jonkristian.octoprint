'use strict';

// node-fetch 3 is ESM-only; keep the Homey entrypoints CommonJS on Node 16+.
module.exports = () => import('node-fetch');
