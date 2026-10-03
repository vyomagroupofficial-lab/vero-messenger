// Writes bots/miniapp/vero-miniapp.js from the bridge source of truth.
//   npx tsx scripts/write-miniapp-client.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_CLIENT_JS } from '../src/features/bots/miniAppBridge';

export const MINIAPP_CLIENT_HEADER =
  '// Vero mini-app client. Include it in your mini-app page (required on web/desktop;\n' +
  '// the mobile app also injects it). Generated from src/features/bots/miniAppBridge.ts\n' +
  '// by scripts/write-miniapp-client.ts - do not edit by hand.\n';

writeFileSync(join(__dirname, '..', 'bots', 'miniapp', 'vero-miniapp.js'), MINIAPP_CLIENT_HEADER + BRIDGE_CLIENT_JS + '\n');
