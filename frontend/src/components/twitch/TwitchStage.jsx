import { useEffect, useRef, useState } from 'react';
import { useRadio } from '../../contexts/RadioContext';

const EMBED_SCRIPT = 'https://player.twitch.tv/js/embed/v1.js';

let scriptPromise = null;

/**
 * Load Twitch's embed script once per session.
 *
 * This is the one remote script in the interface. It is unavoidable: a Twitch
 * stream cannot be played any other way, and a kiosk with no network has no
 * Twitch to show either. Everything else — fonts included — stays local, so
 * losing this costs the Twitch stave and nothing else.
 */
function loadEmbedScript() {
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    if (window.Twitch?.Player) {
      resolve(window.Twitch);
      return;
    }
    const script = document.createElement('script');
    script.src = EMBED_SCRIPT;
    script.async = true;
    script.onload = () =>
      window.Twitch?.Player ? resolve(window.Twitch) : reject(new Error('no player'));
    script.onerror = () => reject(new Error('script blocked'));
    document.head.appendChild(script);
  }).catch((e) => {
    // Let a later mount try again rather than caching the failure forever.
    scriptPromise = null;
    throw e;
  });

  return scriptPromise;
}

/**
 * The stage: where a Twitch channel actually plays.
 *
 * The embed owns the bytes; the engine owns which source is sounding. The
 * stage bridges the two — it registers a controller so the transport's play,
 * pause and stop reach the embed, and it reports the embed's own state back so
 * the transport is never claiming something the stream is not doing.
 *
 * Where the script cannot load, it falls back to a plain iframe that plays but
 * cannot be driven. The engine is told so, and the transport then draws only
 * the controls it can honour.
 */
export default function TwitchStage({ channel }) {
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const { registerTwitchPlayer, reportTwitchState } = useRadio();
  // The stage is mounted with the channel as its key, so there is no state
  // here to reset between channels — a channel change is a remount.
  const [fallback, setFallback] = useState(false);

  // Twitch requires the embedding host to be named. On this device that is
  // whatever the kiosk is served from, which is also what Twitch will see.
  const parent = window.location.hostname;

  useEffect(() => {
    if (!channel) return;

    let cancelled = false;

    loadEmbedScript()
      .then((Twitch) => {
        if (cancelled || !hostRef.current) return;

        const player = new Twitch.Player(hostRef.current, {
          channel: channel.login,
          parent: [parent],
          width: '100%',
          height: '100%',
          // The listener tapped the channel, so this is their gesture.
          autoplay: true,
          muted: false,
          // Chat and the channel's own controls belong on twitch.tv; here the
          // transport at the bottom of the screen is the control surface.
          controls: false,
        });

        playerRef.current = player;

        // PLAY fires when playback is requested and PLAYING when frames are
        // actually arriving. Both are listened for because which one a given
        // embed build emits has moved around, and a transport stuck on
        // "Tuning in" through a playing stream is worse than a duplicate event.
        const sounding = () => {
          if (!cancelled) reportTwitchState('playing', null);
        };
        player.addEventListener(Twitch.Player.PLAY, sounding);
        player.addEventListener(Twitch.Player.PLAYING, sounding);

        player.addEventListener(Twitch.Player.PAUSE, () => {
          if (!cancelled) reportTwitchState('paused');
        });
        player.addEventListener(Twitch.Player.OFFLINE, () => {
          if (!cancelled) reportTwitchState('error', 'That channel is not streaming right now.');
        });
        player.addEventListener(Twitch.Player.ENDED, () => {
          if (!cancelled) reportTwitchState('error', 'The stream ended.');
        });
        // Autoplay refused: the listener's tap was spent elsewhere. Say which
        // control fixes it rather than failing silently.
        player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, () => {
          if (!cancelled) reportTwitchState('paused', 'Press play to start the stream.');
        });

        registerTwitchPlayer({
          play: () => player.play(),
          pause: () => player.pause(),
          stop: () => {
            try {
              player.pause();
            } catch {
              // The embed may already be torn down; stopping is still done.
            }
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        // A bare iframe still plays. It just cannot be driven from here.
        setFallback(true);
        registerTwitchPlayer(null);
        reportTwitchState('playing', null);
      });

    return () => {
      cancelled = true;
      playerRef.current = null;
      registerTwitchPlayer(null);
      if (hostRef.current) hostRef.current.innerHTML = '';
    };
  }, [channel, parent, registerTwitchPlayer, reportTwitchState]);

  if (!channel) return null;

  if (fallback) {
    return (
      <div className="h-full w-full" style={{ background: 'var(--ink)' }}>
        <iframe
          title={`${channel.displayName || channel.login} on Twitch`}
          src={`https://player.twitch.tv/?channel=${encodeURIComponent(channel.login)}&parent=${encodeURIComponent(parent)}&muted=false`}
          className="h-full w-full"
          style={{ border: 0 }}
          allow="autoplay; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }

  return <div ref={hostRef} className="h-full w-full" style={{ background: 'var(--ink)' }} />;
}
