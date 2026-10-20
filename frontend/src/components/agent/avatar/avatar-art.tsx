import type { CSSProperties, ReactNode } from 'react';
import { cn } from '~/lib/utils';
import './avatar.css';
import './face.css';
import type { AvatarState } from './states';

export type AvatarStyle = 'face' | 'bars' | 'dots';

export const AVATAR_STYLES: { id: AvatarStyle; name: string; blurb: string }[] = [
  {
    id: 'face',
    name: 'Face',
    blurb: "pi-d-ui's face, ported as it is: a character with a routine of its own.",
  },
  {
    id: 'bars',
    name: 'Signal',
    blurb: 'A level meter. Precise and technical; the clearest at tiny sizes.',
  },
  {
    id: 'dots',
    name: 'Pixel',
    blurb: 'A round dot matrix, a nod to the terminal. Crisp, playful, cheap to draw.',
  },
];

/** Hues for agents, spread around the wheel and close to pi-d-ui's palette. */
export const AVATAR_HUES = [255, 55, 25, 150, 305, 180, 350, 85] as const;

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/** An agent's own hue, stable across sessions. */
export const avatarHue = (agentId: string): number =>
  AVATAR_HUES[hash(agentId) % AVATAR_HUES.length]!;

/** Seconds into its idle routine this agent starts at, so a list of them does not move in step. */
export const avatarPhase = (agentId: string): number => hash(`phase:${agentId}`) % 24;

export interface AvatarArtProps {
  style: AvatarStyle;
  state: AvatarState;
  /** 0-360. */
  hue: number;
  /** Pixels. */
  size?: number;
  /** Seconds into the idle routine; see avatarPhase. */
  phase?: number;
  /** A disabled agent: grey and still. */
  off?: boolean;
  /** Spoken name. Without one the avatar is decorative (its row says the same in words). */
  label?: string;
  className?: string;
}

/** An agent's animated avatar. All three styles take the same states (see states.ts). */
export function AvatarArt({
  style,
  state,
  hue,
  size = 40,
  phase = 0,
  off = false,
  label,
  className,
}: AvatarArtProps) {
  const css = {
    '--agent-h': hue,
    '--phase': `-${phase}s`,
    fontSize: size,
  } as CSSProperties;
  return (
    <span
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      className={cn('av', `av-${style}`, `av-${state}`, off && 'av-off', className)}
      style={css}
    >
      {style === 'face' && <FaceArt />}
      {style === 'bars' && <BarsArt />}
      {style === 'dots' && <DotsArt />}
    </span>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="av-svg" viewBox="0 0 100 100" aria-hidden="true">
      {children}
    </svg>
  );
}

// ── Face: pi-d-ui's, as it is ───────────────────────────────────────────────────────────────

function FaceArt() {
  return (
    <Svg>
      <g className="face-ring">
        <circle className="face-ring-track" cx="50" cy="50" r="48" />
        <circle className="face-ring-arc" cx="50" cy="50" r="48" pathLength="100" />
      </g>
      <g className="face-body">
        <circle className="face-disc" cx="50" cy="50" r="44" />
        <g className="face-gaze">
          <g className="face-eye face-eye-l">
            <g className="face-blink">
              <rect />
            </g>
          </g>
          <g className="face-eye face-eye-r">
            <g className="face-blink">
              <rect />
            </g>
          </g>
        </g>
        <g className="face-happy">
          <path d="M32 51 Q38.5 41 45 51" />
          <path d="M55 51 Q61.5 41 68 51" />
        </g>
      </g>
      <g className="face-zzz">
        <text className="face-z face-z-1" x="68" y="26">
          z
        </text>
        <text className="face-z face-z-2" x="78" y="15">
          z
        </text>
        <text className="face-z face-z-3" x="88" y="5">
          z
        </text>
      </g>
      <path className="face-sweat" d="M84 20 Q89 28 84 31 Q79 28 84 20 Z" />
      <path
        className="face-sparkle"
        d="M84 4 L86.5 11.5 L94 14 L86.5 16.5 L84 24 L81.5 16.5 L74 14 L81.5 11.5 Z"
      />
      <g className="face-alert">
        <rect x="44" y="12" width="12" height="52" rx="6" />
        <circle cx="50" cy="82" r="7" />
      </g>
    </Svg>
  );
}

// ── Signal ──────────────────────────────────────────────────────────────────────────────────

function BarsArt() {
  return (
    <Svg>
      <rect className="bars-tile" x="4" y="4" width="92" height="92" rx="26" />
      <rect className="bars-ping" x="4" y="4" width="92" height="92" rx="26" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          className="bars-bar"
          style={{ '--i': i } as CSSProperties}
          x={18 + i * 14}
          y="22"
          width="8"
          height="56"
          rx="4"
        />
      ))}
    </Svg>
  );
}

// ── Pixel ───────────────────────────────────────────────────────────────────────────────────

/** Round dot matrix: a 4×4 grid without its corners. `o` is the order around its ring. */
const OUTER: [number, number][] = [
  [1, 0],
  [2, 0],
  [3, 1],
  [3, 2],
  [2, 3],
  [1, 3],
  [0, 2],
  [0, 1],
];
const INNER: [number, number][] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [1, 2],
];
const DOTS = [
  ...INNER.map(([x, y], o) => ({ x, y, o, inner: true })),
  ...OUTER.map(([x, y], o) => ({ x, y, o, inner: false })),
].map((dot, i) => ({ ...dot, i, d: Math.hypot(dot.x - 1.5, dot.y - 1.5) }));

function DotsArt() {
  return (
    <Svg>
      <circle className="dots-back" cx="50" cy="50" r="46" />
      {DOTS.map((dot) => (
        <circle
          key={dot.i}
          className={cn('dot', dot.inner ? 'dot-in' : 'dot-out', dot.i === 0 && 'dot-heart')}
          style={{ '--i': dot.i, '--o': dot.o, '--d': dot.d.toFixed(2) } as CSSProperties}
          cx={20 + dot.x * 20}
          cy={20 + dot.y * 20}
          r="7"
        />
      ))}
    </Svg>
  );
}
