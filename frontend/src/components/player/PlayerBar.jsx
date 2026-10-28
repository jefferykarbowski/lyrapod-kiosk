import { useEffect, useRef, useState } from 'react';
import { useRadio } from '../../contexts/RadioContext';
import { TWITCH } from '../../lib/band';
import { Comb, StationMark } from '../marks/Marks';
import { classNames, duration } from '../../lib/format';

/**
 * The transport. It sits across the bottom for the whole session, because the
 * one thing that must not happen on a listening device is moving between
 * staves and losing the audio.
 *
 * There is no scrubber and no duration: these are live streams with no
 * timeline to scrub. What replaces it is how long *you* have been listening.
 *
 * The hairline along the top is the dial. It carries the live source's colour
 * and a needle at the loaded station's place on the band — the list on the
 * view you are looking at — so next and previous visibly turn something.
 */
export default function PlayerBar() {
  const {
    nowPlaying,
    status,
    error,
    metadata,
    elapsed,
    band,
    position,
    twitchControllable,
    togglePlay,
    stop,
    nextStation,
    prevStation,
    shuffle,
  } = useRadio();

  if (!nowPlaying) return null;

  const twitch = nowPlaying.source === TWITCH;
  const playing = status === 'playing';
  const connecting = status === 'connecting';

  const sourceColor = twitch ? 'var(--sig-violet)' : 'var(--sig-green)';
  const name = twitch
    ? nowPlaying.channel.displayName || nowPlaying.channel.login
    : nowPlaying.station.name;
  const detail = twitch
    ? nowPlaying.channel.title || 'Twitch'
    : nowPlaying.station.place || nowPlaying.station.genre || '';

  // What is playing wins the headline when the stream tells us; the station
  // itself is the fallback.
  const headline = metadata.title
    ? metadata.artist
      ? `${metadata.title} — ${metadata.artist}`
      : metadata.title
    : name;

  // An embed we could not get a handle on cannot be paused from here, so the
  // play control is not drawn rather than drawn dead. Stop still works: it
  // unmounts the embed.
  const canToggle = !twitch || twitchControllable;
  const canStep = !band || band.entries.length > 1;

  return (
    <section
      aria-label="Transport"
      className="flex-shrink-0 seam-t"
      style={{ background: 'var(--ink-2)' }}
    >
      {/* The dial. */}
      <div
        aria-hidden="true"
        className="dial"
        style={{
          background: `linear-gradient(90deg, transparent, ${sourceColor}, transparent)`,
          opacity: playing ? 0.9 : 0.3,
          transition: 'opacity 300ms',
        }}
      >
        {position && (
          <span
            className="dial-needle"
            style={{
              left: `${((position.index + 0.5) / position.count) * 100}%`,
              background: sourceColor,
            }}
          />
        )}
      </div>

      {/* One announcement per station change, whoever turned the dial. */}
      <p className="sr-only" aria-live="polite">
        Now playing {name}
      </p>

      <div className="flex items-stretch gap-px" style={{ background: 'var(--ink-3)' }}>
        <div className="flex items-center gap-px" style={{ background: 'var(--ink-2)' }}>
          <Transport
            label={canStep ? 'Previous station' : 'Nothing else on this list'}
            onClick={prevStation}
            disabled={!canStep}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 5h2.5v14H6zM20 5v14L9.5 12z" />
            </svg>
          </Transport>

          {canToggle ? (
            <Transport
              label={playing ? 'Pause' : 'Play'}
              onClick={togglePlay}
              primary
              color={sourceColor}
            >
              {connecting ? (
                <span className="block h-5 w-7" style={{ color: 'var(--ink)' }}>
                  <Comb seed="connecting" bars={5} animated className="h-full w-full" height={18} />
                </span>
              ) : playing ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M7 4h4v16H7zM13 4h4v16h-4z" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M6 3l16 9-16 9z" />
                </svg>
              )}
            </Transport>
          ) : (
            // Twitch without a controllable embed: say where the controls are
            // instead of offering ones that do nothing.
            <p
              className="flex items-center px-4 text-[12.5px]"
              style={{ color: 'var(--chalk-3)', minHeight: 64 }}
            >
              Controls are in the stream
            </p>
          )}

          <Transport
            label={canStep ? 'Next station' : 'Nothing else on this list'}
            onClick={nextStation}
            disabled={!canStep}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M15.5 5H18v14h-2.5zM4 5l10.5 7L4 19z" />
            </svg>
          </Transport>

          <Transport
            label={
              canStep
                ? `Random station from ${band?.label ?? 'the catalogue'}`
                : 'Nothing else on this list'
            }
            onClick={shuffle}
            disabled={!canStep}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 7h3.2c1.8 0 3.4.9 4.5 2.4l4.2 5.7c1 1.4 2.7 2.3 4.5 2.3H21M3 17h3.2c1.8 0 3.4-.9 4.5-2.4l4.2-5.7C16 7.5 17.6 6.6 19.4 6.6H21" strokeLinecap="round" />
              <path d="M18.4 4 21 6.6l-2.6 2.6M18.4 14.6 21 17.2l-2.6 2.6" strokeLinecap="round" />
            </svg>
          </Transport>
        </div>

        {/* The realization: artwork where the stream gave us some, the loaded
            station's own mark otherwise. */}
        <div
          className="hidden w-[64px] flex-shrink-0 items-center justify-center sm:flex"
          style={{ background: 'var(--ink-2)' }}
        >
          <Realization
            artwork={metadata.artwork}
            fallbackLogo={twitch ? nowPlaying.channel.thumbnail : nowPlaying.station.logo}
            name={name}
            playing={playing}
            color={sourceColor}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center px-4 py-2" style={{ background: 'var(--ink-2)' }}>
          <p className="stave-label" style={{ fontSize: 10.5, color: playing ? sourceColor : 'var(--chalk-3)' }}>
            {connecting ? 'Tuning in' : playing ? 'On air' : status === 'error' ? 'Off air' : 'Paused'}
          </p>

          <Marquee text={headline} />

          <p className="mt-0.5 flex min-w-0 items-center gap-2 truncate text-[12.5px]" style={{ color: 'var(--chalk-2)' }}>
            <span className="truncate font-mono">{name}</span>
            {detail && (
              <>
                <span style={{ color: 'var(--chalk-3)' }}>·</span>
                <span className="truncate">{detail}</span>
              </>
            )}
            {playing && (
              <>
                <span style={{ color: 'var(--chalk-3)' }}>·</span>
                <span
                  className="whitespace-nowrap font-mono tnum"
                  style={{ color: 'var(--chalk-3)' }}
                  title="How long you have been listening"
                >
                  {duration(elapsed)}
                </span>
              </>
            )}
            {position && (
              <>
                <span className="hidden lg:inline" style={{ color: 'var(--chalk-3)' }}>·</span>
                <span
                  className="hidden whitespace-nowrap font-mono tnum lg:inline"
                  style={{ color: 'var(--chalk-3)' }}
                  title="Where this station sits on the list you are stepping through"
                >
                  {position.index + 1} of {position.count} · {position.label}
                </span>
              </>
            )}
          </p>

          {error && (
            <p role="alert" className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--sig-amber)' }}>
              {error}
            </p>
          )}
        </div>

        {/* The live level, a working meter rather than an ornament. */}
        <div
          className="hidden w-[120px] flex-shrink-0 items-center px-3 xl:flex"
          style={{ background: 'var(--ink-2)', color: sourceColor, opacity: playing ? 1 : 0.22 }}
        >
          <Comb
            seed={twitch ? nowPlaying.channel.login : nowPlaying.station.id}
            bars={18}
            animated={playing}
            className="h-6 w-full"
            height={22}
          />
        </div>

        <button
          onClick={stop}
          aria-label="Stop and clear the transport"
          className="tap flex flex-shrink-0 items-center justify-center px-4"
          style={{ background: 'var(--ink-2)', color: 'var(--chalk-3)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </section>
  );
}

/** Square, hairline-bounded, sized for wet hands — 64px is the floor. */
function Transport({ label, onClick, disabled, primary = false, color, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex items-center justify-center transition-colors duration-150 disabled:opacity-25"
      style={{
        width: primary ? 84 : 64,
        height: 64,
        border: `1px solid ${primary ? color : 'var(--ink-4)'}`,
        background: primary ? color : 'transparent',
        color: primary ? 'var(--ink)' : 'var(--chalk)',
      }}
    >
      {children}
    </button>
  );
}

/**
 * Cover art is best-effort: platforms point at art that has since gone away,
 * so a failed load falls back to the mark rather than to a broken-image glyph.
 */
function Realization({ artwork, fallbackLogo, name, playing, color }) {
  // Which image failed, rather than whether one did: a new track's art
  // deserves a fresh attempt even if the last one 404'd, and remembering the
  // url that broke gets that without resetting state from an effect.
  const [failedSource, setFailedSource] = useState(null);
  const source = artwork || fallbackLogo;
  const failed = source != null && source === failedSource;

  if (!source || failed) {
    return (
      <span className="block h-7 w-9" style={{ color }}>
        <StationMark name={name} playing={playing} className="h-full w-full" />
      </span>
    );
  }

  return (
    <img
      src={source}
      alt=""
      className="h-11 w-11 object-contain"
      style={{ border: '1px solid var(--ink-4)' }}
      loading="lazy"
      onError={() => setFailedSource(source)}
    />
  );
}

/** Scrolls only when the title genuinely does not fit. */
function Marquee({ text }) {
  const wrapperRef = useRef(null);
  const innerRef = useRef(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const inner = innerRef.current;
    if (!wrapper || !inner) return;

    const measure = () => {
      const overflow = inner.scrollWidth - wrapper.clientWidth;
      setShift(overflow > 4 ? -overflow - 8 : 0);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      ref={wrapperRef}
      className={classNames('overflow-hidden whitespace-nowrap', shift !== 0 && 'marquee')}
      style={{ '--marquee-shift': `${shift}px` }}
    >
      <span ref={innerRef} className="text-[16px] font-semibold leading-tight" style={{ color: 'var(--chalk)' }}>
        {text}
      </span>
    </div>
  );
}
