// Platform split: Metro picks webrtc.native.ts on iOS/Android and
// webrtc.web.ts on web. This file only exists for the TypeScript checker
// (which doesn't know about platform extensions); both implementations
// export the same `mediaAdapter: MediaAdapter`.
export { mediaAdapter } from './webrtc.web';
