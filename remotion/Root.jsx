import { Composition } from 'remotion';
import { ScriptVideo, calculateScriptVideoMetadata } from './ScriptVideo';

export const RemotionRoot = () => {
  return (
    <Composition
      id="ScriptVideo"
      component={ScriptVideo}
      durationInFrames={900}
      fps={30}
      width={1080}
      height={1920}
      calculateMetadata={calculateScriptVideoMetadata}
      defaultProps={{
        hook: 'Want to launch your own trading platform in 90 days?',
        beats: [
          'Most founders spend months building from scratch.',
          'WhiteBeard\'s Pawn AI handles A-Book/B-Book decisions in real time.',
          'Install in 15 minutes, no setup fee, no contract.',
        ],
        cta: 'DM WhiteBeard for a free simulation report on your book',
        estimatedDurationSec: 30,
      }}
    />
  );
};
