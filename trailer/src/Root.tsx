import React from 'react';
import {Composition} from 'remotion';
import {Trailer} from './Trailer';
import {DURATION, FPS} from './timing';

export const Root: React.FC = () => (
  <>
    <Composition id="VeroTrailer" component={Trailer} durationInFrames={DURATION} fps={FPS} width={1920} height={1080} />
    <Composition id="VeroTrailerVertical" component={Trailer} durationInFrames={DURATION} fps={FPS} width={1080} height={1920} />
  </>
);
