import { ChevronDown, Moon, Pause, Play, Sun } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  AVATAR_HUES,
  AVATAR_STYLES,
  AvatarArt,
  type AvatarStyle,
  avatarPhase,
} from '~/components/agent/avatar/avatar-art';
import {
  AVATAR_STATES,
  type AvatarState,
  STATE_INFO,
  useDoneFlash,
} from '~/components/agent/avatar/states';
import { usePageTitle } from '~/lib/document-title';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

/**
 * A review page for the agent avatar styles: a reel through every state, every
 * style side by side, and a scripted scene of them in the app's own places.
 * Open /avatars in development.
 */

const REEL_MS = 3600;

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; name: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)] p-0.5"
    >
      {options.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control is a radio group of buttons
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-[0.65rem] px-3 py-1.5 text-sm font-medium transition-colors',
            value === option.id
              ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {note && <p className="mt-0.5 text-sm text-[var(--text-muted)]">{note}</p>}
      </div>
      {children}
    </section>
  );
}

// ── The scripted scene ───────────────────────────────────────────────────────────────────────

interface Step {
  state: AvatarState;
  ms: number;
  detail?: string;
}

/** Four agents, each living its own day. Finishing work flashes "done" by itself (useDoneFlash). */
const SCENE: { name: string; hue: number; off?: boolean; steps: readonly Step[] }[] = [
  {
    name: 'Assistant',
    hue: AVATAR_HUES[0],
    steps: [
      { state: 'idle', ms: 3200 },
      { state: 'thinking', ms: 2200 },
      { state: 'working', ms: 2000, detail: 'get_time' },
      { state: 'thinking', ms: 1600 },
      { state: 'idle', ms: 5200 },
    ],
  },
  {
    name: 'Coder',
    hue: AVATAR_HUES[1],
    steps: [
      { state: 'idle', ms: 1800 },
      { state: 'thinking', ms: 1400 },
      { state: 'working', ms: 4200, detail: 'bash · pnpm test' },
      { state: 'error', ms: 3400, detail: 'Tests failed' },
      { state: 'idle', ms: 3600 },
    ],
  },
  {
    name: 'Researcher',
    hue: AVATAR_HUES[3],
    steps: [
      { state: 'asleep', ms: 3400 },
      { state: 'waiting', ms: 2200, detail: 'Waking Researcher…' },
      { state: 'thinking', ms: 2600 },
      { state: 'working', ms: 3000, detail: 'web_search · pgvector' },
      { state: 'attention', ms: 4600, detail: 'Reply waiting' },
      { state: 'asleep', ms: 3000 },
    ],
  },
  { name: 'Archivist', hue: AVATAR_HUES[4], off: true, steps: [{ state: 'asleep', ms: 60_000 }] },
];

function useScene(steps: readonly Step[]) {
  const [index, setIndex] = useState(0);
  const step = steps[index]!;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each step starts its own timer, so it restarts when the step changes
  useEffect(() => {
    const timer = setTimeout(() => setIndex((n) => (n + 1) % steps.length), step.ms);
    return () => clearTimeout(timer);
  }, [index, step.ms, steps.length]);
  const state = useDoneFlash(step.state);
  return { state, detail: step.detail };
}

const statusText = (state: AvatarState, detail?: string) =>
  state === 'done' ? 'Finished' : (detail ?? STATE_INFO[state].short);

export function AvatarsDemoPage() {
  usePageTitle('Agent avatars');
  const { resolvedTheme, setTheme } = useTheme();
  const [style, setStyle] = useState<AvatarStyle>('face');
  const [hue, setHue] = useState<number>(AVATAR_HUES[0]);
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);
  const state = AVATAR_STATES[index]!;
  const info = AVATAR_STYLES.find((candidate) => candidate.id === style)!;

  // The reel: through every state, then round again, until a state is chosen by hand.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each state starts its own timer, so it restarts when the state changes
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => setIndex((n) => (n + 1) % AVATAR_STATES.length), REEL_MS);
    return () => clearTimeout(timer);
  }, [auto, index]);

  const scene = [
    useScene(SCENE[0]!.steps),
    useScene(SCENE[1]!.steps),
    useScene(SCENE[2]!.steps),
    useScene(SCENE[3]!.steps),
  ];

  return (
    <div
      className={cn(
        'h-dvh overflow-y-auto bg-[var(--bg-root)] text-[var(--text-primary)]',
        paused && 'av-paused',
        still && 'av-still',
      )}
    >
      <div className="mx-auto max-w-6xl space-y-14 px-6 py-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Agent avatars</h1>
            <p className="mt-1 max-w-xl text-sm text-[var(--text-muted)]">
              Three styles, one set of states. Each avatar is drawn from the agent's hue and moves
              with what the agent is doing. Choose one; it replaces the initials.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPaused(!paused)}
              aria-pressed={paused}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 py-1.5 text-sm"
            >
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {paused ? 'Play' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={() => setStill(!still)}
              aria-pressed={still}
              title="Every state is still a distinct pose without motion"
              className={cn(
                'rounded-xl border border-[var(--border-subtle)] px-3 py-1.5 text-sm',
                still
                  ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                  : 'bg-[var(--bg-control)]',
              )}
            >
              Reduced motion
            </button>
            <button
              type="button"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
              className="inline-flex size-9 items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]"
            >
              {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </div>
        </header>

        {/* ── The reel ─────────────────────────────────────────────────────────────── */}
        <Section title="The reel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label="Style"
              value={style}
              onChange={setStyle}
              options={AVATAR_STYLES.map((candidate) => ({
                id: candidate.id,
                name: candidate.name,
              }))}
            />
            <fieldset className="m-0 flex items-center gap-1.5 border-0 p-0">
              <legend className="sr-only">Hue</legend>
              {AVATAR_HUES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-label={`Hue ${candidate}`}
                  aria-pressed={hue === candidate}
                  onClick={() => setHue(candidate)}
                  className={cn(
                    'size-6 rounded-full border-2 transition-transform',
                    hue === candidate
                      ? 'scale-110 border-[var(--text-primary)]'
                      : 'border-transparent',
                  )}
                  style={{ background: `oklch(0.7 0.17 ${candidate})` }}
                />
              ))}
            </fieldset>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">{info.blurb}</p>

          <div
            id="reel-stage"
            className="relative overflow-hidden rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-app)]"
            style={{
              backgroundImage: `radial-gradient(60% 70% at 50% 42%, oklch(0.7 0.17 ${hue} / 0.14), transparent 72%)`,
            }}
          >
            <div className="grid items-center gap-8 px-8 py-10 md:grid-cols-[auto_1fr]">
              <div className="flex justify-center md:px-10">
                <AvatarArt
                  style={style}
                  state={state}
                  hue={hue}
                  size={176}
                  phase={3}
                  label={`${info.name}: ${STATE_INFO[state].label}`}
                />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold tracking-wide text-[var(--accent-bright)] uppercase">
                  {index + 1} of {AVATAR_STATES.length}
                </p>
                <p className="mt-1 text-3xl font-bold tracking-tight">{STATE_INFO[state].label}</p>
                <p className="mt-2 max-w-md text-[var(--text-secondary)]">
                  {STATE_INFO[state].when}
                </p>
                <div className="mt-5 flex items-center gap-3 text-sm text-[var(--text-muted)]">
                  <span>Sidebar</span>
                  <AvatarArt style={style} state={state} hue={hue} size={20} phase={3} />
                  <AvatarArt style={style} state={state} hue={hue} size={28} phase={3} />
                  <AvatarArt style={style} state={state} hue={hue} size={40} phase={3} />
                </div>
              </div>
            </div>
            {auto && (
              <div
                key={`${style}-${index}`}
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-[var(--accent-bright)]"
                style={{ animation: `av-reel ${REEL_MS}ms linear forwards` }}
              />
            )}
          </div>

          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {AVATAR_STATES.map((candidate, at) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={at === index}
                onClick={() => {
                  setIndex(at);
                  setAuto(false);
                }}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-2xl border px-2 py-3 text-xs font-medium transition-colors',
                  at === index
                    ? 'border-[var(--accent-button-border)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:bg-[var(--bg-control)]',
                )}
              >
                <AvatarArt style={style} state={candidate} hue={hue} size={44} phase={at * 3} />
                {STATE_INFO[candidate].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAuto(!auto)}
            className="text-sm text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
          >
            {auto ? 'Stop the reel to hold a state' : 'Play the reel'}
          </button>
        </Section>

        {/* ── Every style, every state ──────────────────────────────────────────── */}
        <Section title="Side by side" note="Every style in every state, live.">
          <div
            id="side-by-side"
            className="overflow-x-auto rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-app)]"
          >
            <table className="w-full min-w-[56rem] border-collapse text-center">
              <thead>
                <tr className="text-xs text-[var(--text-muted)]">
                  <th className="p-3" />
                  {AVATAR_STATES.map((candidate) => (
                    <th key={candidate} className="p-3 font-medium">
                      {STATE_INFO[candidate].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {AVATAR_STYLES.map((candidate) => (
                  <tr key={candidate.id} className="border-t border-[var(--border-subtle)]">
                    <th className="p-3 text-left text-sm font-semibold">{candidate.name}</th>
                    {AVATAR_STATES.map((cell, at) => (
                      <td key={cell} className="p-3">
                        <AvatarArt
                          style={candidate.id}
                          state={cell}
                          hue={hue}
                          size={60}
                          phase={at * 5}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── In the app ────────────────────────────────────────────────────────── */}
        <Section
          title="In the app"
          note="A scripted scene in the places avatars live. Watch Assistant finish a reply, Coder fail a run, and Researcher wake, search and wait for you."
        >
          <div className="grid gap-6 md:grid-cols-[18rem_1fr]">
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-3">
              <p className="px-2.5 pb-2 text-[0.6875rem] font-semibold text-[var(--accent-bright)]">
                Agents
              </p>
              <ul className="space-y-0.5">
                {SCENE.map((agent, at) => (
                  <li
                    key={agent.name}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors',
                      scene[at]!.state === 'attention' && 'bg-[var(--accent-soft)]',
                    )}
                  >
                    <AvatarArt
                      style={style}
                      state={scene[at]!.state}
                      hue={agent.hue}
                      size={28}
                      phase={at * 7}
                      off={agent.off}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
                        {agent.name}
                      </span>
                      <span className="block truncate text-xs text-[var(--text-muted)]">
                        {agent.off ? 'Disabled' : statusText(scene[at]!.state, scene[at]!.detail)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] px-5 py-4">
                <AvatarArt
                  style={style}
                  state={scene[0]!.state}
                  hue={SCENE[0]!.hue}
                  size={48}
                  phase={2}
                />
                <div>
                  <p className="font-semibold">Assistant</p>
                  <p className="text-sm text-[var(--text-muted)]">
                    {statusText(scene[0]!.state, scene[0]!.detail)}
                  </p>
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)] p-4">
                <p className="text-sm text-[var(--text-muted)]">Message Coder…</p>
                <div className="mt-5 flex items-center">
                  <span className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[0.8125rem] font-semibold">
                    <AvatarArt
                      style={style}
                      state={scene[1]!.state}
                      hue={SCENE[1]!.hue}
                      size={20}
                      phase={5}
                    />
                    Coder
                    <ChevronDown className="size-4 text-[var(--text-muted)]" />
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-4">
                <AvatarArt
                  style={style}
                  state={scene[2]!.state}
                  hue={SCENE[2]!.hue}
                  size={32}
                  phase={9}
                />
                <div className="min-w-0 text-sm">
                  <p className="font-medium">Researcher</p>
                  <p className="text-[var(--text-secondary)]">
                    {scene[2]!.state === 'thinking' || scene[2]!.state === 'working'
                      ? 'Looking into it…'
                      : scene[2]!.state === 'attention'
                        ? 'Here is what I found.'
                        : 'Ask me to research something.'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Section>

        {/* ── Sizes and hues ───────────────────────────────────────────────────── */}
        <Section
          title="Sizes and hues"
          note="Thinking and working, from a list row to a hero; then every hue at rest."
        >
          <div className="space-y-6 rounded-3xl border border-[var(--border-subtle)] bg-[var(--bg-app)] p-6">
            {AVATAR_STYLES.map((candidate) => (
              <div key={candidate.id} className="flex flex-wrap items-end gap-x-8 gap-y-3">
                <span className="w-16 text-sm font-semibold">{candidate.name}</span>
                {[16, 20, 28, 40, 64, 96].map((size) => (
                  <AvatarArt
                    key={size}
                    style={candidate.id}
                    state={size % 8 === 0 ? 'working' : 'thinking'}
                    hue={hue}
                    size={size}
                    phase={size}
                  />
                ))}
                <span className="mx-2 h-8 w-px bg-[var(--border-subtle)]" />
                {AVATAR_HUES.map((candidateHue, at) => (
                  <AvatarArt
                    key={candidateHue}
                    style={candidate.id}
                    state="idle"
                    hue={candidateHue}
                    size={36}
                    phase={avatarPhase(`h${at}`)}
                  />
                ))}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
