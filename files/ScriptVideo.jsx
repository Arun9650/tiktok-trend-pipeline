import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

const FPS = 30;
const COLORS = {
  bg: '#0a0a0a',
  text: '#f5f5f5',
  accent: '#3ddc84',
  dim: '#6b6b6b',
};

// Remotion calls this before rendering to figure out how long the video
// should be, driven by the script's own estimatedDurationSec instead of a
// fixed number baked into the composition.
export function calculateScriptVideoMetadata({ props }) {
  const totalSec = props.estimatedDurationSec || 30;
  return {
    durationInFrames: Math.round(totalSec * FPS),
    fps: FPS,
    width: 1080,
    height: 1920,
  };
}

// Subtle animated line in the background so the video isn't just flat text
// on a black screen. Not a real price feed, just motion to hold attention.
function ChartBackground() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const points = 40;
  const path = Array.from({ length: points }, (_, i) => {
    const x = (i / (points - 1)) * width;
    const y =
      height * 0.5 +
      Math.sin(i * 0.5 + frame * 0.03) * 120 +
      Math.sin(i * 0.15 - frame * 0.02) * 60;
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} style={{ position: 'absolute', opacity: 0.15 }}>
      <path d={path} stroke={COLORS.accent} strokeWidth={4} fill="none" />
    </svg>
  );
}

function Brand() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 80,
        width: '100%',
        textAlign: 'center',
        color: COLORS.dim,
        fontSize: 32,
        fontFamily: 'Arial, sans-serif',
        letterSpacing: 4,
      }}
    >
      WHITEBEARD.AI
    </div>
  );
}

// Simple fade + rise-in for each text beat, so cuts don't feel like a
// slideshow. Fully re-evaluates per Sequence, since useCurrentFrame() inside
// a Sequence is relative to that Sequence's own start, not the whole video.
function TextCard({ children, size = 64 }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  const translateY = interpolate(frame, [0, 10], [30, 0], { extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        color: COLORS.text,
        fontSize: size,
        fontWeight: 700,
        fontFamily: 'Arial, sans-serif',
        textAlign: 'center',
        padding: '0 80px',
        lineHeight: 1.25,
      }}
    >
      {children}
    </div>
  );
}

export function ScriptVideo({ hook, beats, cta, estimatedDurationSec = 30 }) {
  const totalFrames = Math.round(estimatedDurationSec * FPS);
  const hookFrames = Math.round(totalFrames * 0.2);
  const ctaFrames = Math.round(totalFrames * 0.2);
  const beatsFrames = totalFrames - hookFrames - ctaFrames;
  const safeBeats = beats && beats.length > 0 ? beats : ['(no beats provided)'];
  const perBeat = Math.floor(beatsFrames / safeBeats.length);

  let cursor = hookFrames;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <ChartBackground />

      <Sequence from={0} durationInFrames={hookFrames}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
          <TextCard size={76}>{hook}</TextCard>
        </AbsoluteFill>
      </Sequence>

      {safeBeats.map((beat, i) => {
        const from = cursor;
        cursor += perBeat;
        return (
          <Sequence key={i} from={from} durationInFrames={perBeat}>
            <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
              <TextCard size={58}>{beat}</TextCard>
            </AbsoluteFill>
          </Sequence>
        );
      })}

      <Sequence from={hookFrames + beatsFrames} durationInFrames={ctaFrames}>
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
          <TextCard size={54}>{cta}</TextCard>
        </AbsoluteFill>
      </Sequence>

      <Brand />
    </AbsoluteFill>
  );
}
