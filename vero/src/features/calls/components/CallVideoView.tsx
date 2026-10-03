// Platform split: Metro picks CallVideoView.native.tsx (RTCView) on iOS /
// Android and CallVideoView.web.tsx (<video>) on web. This file exists for
// the TypeScript checker only.
export { CallVideoView } from './CallVideoView.web';
export type { CallVideoViewProps } from './callVideoTypes';
