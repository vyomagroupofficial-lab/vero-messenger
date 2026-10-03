// Runs in an isolated, sandboxed context. Exposes only static, harmless facts;
// the web app never gets Node.js or Electron APIs.
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('veroDesktop', Object.freeze({ isDesktop: true, platform: process.platform }));
