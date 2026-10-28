import { useCallback } from 'react';
import { useRadio } from '../../contexts/RadioContext';
import { useSources } from '../../contexts/SourcesContext';
import { Comb, Block, Stipple } from '../marks/Marks';

/** The mark that sits inside a stave, drawn in that stave's colour. */
function StaveMark({ kind, id, live }) {
  const cls = 'w-full h-full';
  if (kind === 'comb') return <Comb seed={id} bars={8} animated={live} className={cls} height={20} />;
  if (kind === 'block') return <Block seed={id} rows={3} className={cls} />;
  return <Stipple seed={id} count={44} animated={live} className={cls} />;
}

/**
 * The stave rail. Each source is a horizontal stave carrying its own colour;
 * the live one is marked by a solid rule and a moving mark, not by a fill —
 * colour identifies, motion indicates state.
 */
export default function Navigation() {
  const { activeTab, setActiveTab, stop, nowPlaying, isPlaying } = useRadio();
  const { enabled } = useSources();

  const handleSelect = useCallback(
    (source) => {
      if (activeTab === source.id) return;
      if (source.status !== 'live') return;

      // Radio plays from an <audio> element that outlives the view, so leaving
      // the stave no longer stops it — that is what the persistent transport
      // is for. Twitch is the exception: its video embed is unmounted with the
      // stave, so the audio stops whatever we do here, and clearing the
      // transport is more honest than leaving it claiming to play.
      if (nowPlaying?.source === 'twitch' && source.id !== 'twitch') stop();

      setActiveTab(source.id);
    },
    [activeTab, setActiveTab, stop, nowPlaying]
  );

  return (
    <nav aria-label="Listening sources" className="flex items-stretch">
      {enabled.map((source) => {
        const active = activeTab === source.id;
        // A stave's mark moves when *that source* is sounding, which is no
        // longer the same as the stave being on screen: the radio keeps
        // playing while you read the Spotify stave, and the rail should say so.
        const live = isPlaying && nowPlaying?.source === source.id;

        return (
          <button
            key={source.id}
            onClick={() => handleSelect(source)}
            aria-current={active ? 'true' : undefined}
            className="group relative tap flex flex-col justify-between px-4 pt-2.5 pb-2 text-left transition-colors duration-200 seam-r"
            style={{
              minWidth: 132,
              background: active ? 'var(--ink-2)' : 'transparent',
              color: active ? source.color : 'var(--chalk-2)',
            }}
          >
            {/* The stave rule. Solid and coloured when live, hairline otherwise. */}
            <span
              aria-hidden="true"
              className="absolute left-0 right-0 top-0 transition-all duration-300"
              style={{
                height: active ? 3 : 1,
                background: active ? source.color : 'var(--ink-3)',
              }}
            />

            <span className="stave-label" style={{ color: active ? source.color : 'var(--chalk-2)' }}>
              {source.label}
            </span>

            <span className="mt-1.5 block h-5 w-full" style={{ color: source.color, opacity: active ? 1 : 0.32 }}>
              <StaveMark kind={source.mark} id={source.id} live={live} />
            </span>
          </button>
        );
      })}
    </nav>
  );
}
