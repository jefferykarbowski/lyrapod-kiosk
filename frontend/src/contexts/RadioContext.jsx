import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { DEFAULT_STATIONS } from '../config/stations';
import { RADIO, TWITCH, entryId } from '../lib/band';

const RadioContext = createContext(null);

/**
 * The listening engine.
 *
 * One <audio> element lives for the life of the app, so moving between staves
 * never cuts the stream — the one thing that must not happen on a listening
 * device. Live Icecast mounts have no duration and cannot seek, so there is
 * deliberately no scrubber: play, pause, volume, and the dial.
 *
 * THE DIAL. Next, previous and shuffle step through a *band*: the stations
 * listed on the view you are looking at, in that view's order. A view
 * registers its list through `useBand`; the engine remembers the last one, and
 * falls back to the whole catalogue, so no transport control is ever dead.
 * It is a tuner, not a playlist — there is no queue to edit.
 *
 * TWITCH. A Twitch channel is video and cannot come out of an <audio>
 * element, so it plays in an embed that registers a controller here. The
 * engine owns which source is sounding; the embed owns the bytes. When the
 * embed could not be controlled, the transport hides the controls it cannot
 * honour rather than drawing dead ones.
 */

const SCREENSAVER_TIMEOUT = 60 * 60 * 1000;

export function RadioProvider({ children }) {
  const [stations] = useState(DEFAULT_STATIONS);

  // What is loaded: { source, station } for radio, { source, channel } for
  // Twitch. `currentStation` below is the radio-shaped view of it, kept for
  // the components that only ever deal in stations.
  const [nowPlaying, setNowPlaying] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState({ artist: '', title: '', artwork: null });
  const [volume, setVolume] = useState(1.0);
  const [elapsed, setElapsed] = useState(0);
  const [activeTab, setActiveTab] = useState(RADIO);
  const [showScreensaver, setShowScreensaver] = useState(false);
  const [lastActivityTime, setLastActivityTime] = useState(Date.now());

  const audioRef = useRef(null);
  const wsRef = useRef(null);
  /** Guards against a slow stream resolving after the listener moved on. */
  const loadTokenRef = useRef(0);

  // The dial. Refs mirror state so two quick presses of next both see the
  // station the first one chose, not the one React has not re-rendered yet.
  const nowPlayingRef = useRef(null);
  const bandsRef = useRef(new Map());
  const pageBandRef = useRef(null);
  const lastBandRef = useRef(null);
  const [pageBand, setPageBand] = useState(null);
  const shuffleRef = useRef({ key: '', remaining: [] });

  // The Twitch embed's controller, registered by the stage while it is mounted.
  const twitchRef = useRef(null);
  const [twitchControllable, setTwitchControllable] = useState(false);

  const isPlaying = status === 'playing';

  /* ----------------------------------------------------------- screensaver */

  const resetActivity = useCallback(() => {
    setLastActivityTime(Date.now());
    setShowScreensaver(false);
  }, []);

  useEffect(() => {
    const checkInactivity = () => {
      if (!isPlaying && Date.now() - lastActivityTime >= SCREENSAVER_TIMEOUT) {
        setShowScreensaver(true);
      }
    };

    const interval = setInterval(checkInactivity, 60000);

    if (isPlaying) {
      setShowScreensaver(false);
      setLastActivityTime(Date.now());
    }

    return () => clearInterval(interval);
  }, [isPlaying, lastActivityTime]);

  const dismissScreensaver = useCallback(() => {
    setShowScreensaver(false);
    setLastActivityTime(Date.now());
  }, []);

  const triggerScreensaver = useCallback(() => setShowScreensaver(true), []);

  /* --------------------------------------------------------- the element */

  if (!audioRef.current && typeof Audio !== 'undefined') {
    const element = new Audio();
    element.preload = 'none';
    // Deliberately NO crossOrigin attribute: it forces CORS mode, and any
    // Icecast that omits Access-Control-Allow-Origin refuses to play at all.
    // Plain no-CORS <audio> playback needs nothing from the server.
    audioRef.current = element;
  }

  // Element state to engine state. These events, not the call sites, are what
  // `status` reflects, so a stream that drops on its own is still reported.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlaying = () => {
      setStatus('playing');
      setError(null);
    };
    const onPause = () => setStatus((s) => (s === 'error' ? s : 'paused'));
    const onWaiting = () => setStatus((s) => (s === 'playing' ? 'connecting' : s));
    const onError = () => {
      if (!audio.src) return; // teardown, not a failure
      setStatus('error');
      setError('That stream is not responding. It may be off the air.');
    };

    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('stalled', onWaiting);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('stalled', onWaiting);
      audio.removeEventListener('error', onError);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // How long you have been listening. There is no track length to show on a
  // live stream, so this is what replaces a progress bar.
  useEffect(() => {
    if (status !== 'playing') return;
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  /* --------------------------------------------------------------- play */

  const stop = useCallback(() => {
    loadTokenRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      // Detaching the source is what actually closes the socket to the station.
      audio.removeAttribute('src');
      audio.load();
    }
    twitchRef.current?.stop?.();
    nowPlayingRef.current = null;
    setNowPlaying(null);
    setStatus('idle');
    setError(null);
    setElapsed(0);
    setMetadata({ artist: '', title: '', artwork: null });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
  }, []);

  const playStation = useCallback(
    (station) => {
      const audio = audioRef.current;
      if (!audio || !station) return;

      // Tapping the station that is already playing is a pause, not a restart.
      const loaded = nowPlayingRef.current;
      if (loaded?.source === RADIO && loaded.station.id === station.id && status === 'playing') {
        audio.pause();
        setStatus('paused');
        return;
      }

      if (!station.streamUrl) {
        setStatus('error');
        setError('No stream is listed for this station.');
        return;
      }

      // A Twitch channel and a radio stream cannot both sound at once.
      twitchRef.current?.stop?.();

      const token = ++loadTokenRef.current;
      const next = { source: RADIO, station };
      nowPlayingRef.current = next;
      setNowPlaying(next);
      setStatus('connecting');
      setError(null);
      setElapsed(0);
      setMetadata({ artist: '', title: '', artwork: null });

      // Spotify holds the system's audio sink; it has to let go first. Fired
      // without awaiting, because the stream should not wait on a tab that
      // may not even be connected.
      fetch('/api/spotify/pause', { method: 'PUT' }).catch(() => {});

      audio.src = station.streamUrl;
      audio.load();
      audio.play().catch((err) => {
        if (token !== loadTokenRef.current) return;
        if (err?.name === 'NotAllowedError') {
          // Autoplay policy: the gesture was spent elsewhere.
          setStatus('paused');
          setError('Press play to start the stream.');
        } else {
          setStatus('error');
          setError('That stream would not start. It may be off the air.');
        }
      });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'play', streamUrl: station.streamUrl }));
      }
    },
    [status],
  );

  /**
   * Load a Twitch channel. The bytes are the embed's job; this records which
   * channel the engine considers loaded and silences the radio.
   */
  const playChannel = useCallback((channel) => {
    if (!channel) return;

    const loaded = nowPlayingRef.current;
    if (loaded?.source === TWITCH && loaded.channel.login === channel.login) {
      // Already on this channel — treat a second tap as play/pause where the
      // embed lets us, and as nothing where it does not.
      if (status === 'playing') {
        twitchRef.current?.pause?.();
        setStatus('paused');
      } else {
        twitchRef.current?.play?.();
      }
      return;
    }

    loadTokenRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    const next = { source: TWITCH, channel };
    nowPlayingRef.current = next;
    setNowPlaying(next);
    setStatus('connecting');
    setError(null);
    setElapsed(0);
    setMetadata({ artist: '', title: '', artwork: null });

    fetch('/api/spotify/pause', { method: 'PUT' }).catch(() => {});

    // The station's ICY reader has nothing to read from a Twitch channel.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
  }, [status]);

  /** The stage calls this as the embed comes and goes. */
  const registerTwitchPlayer = useCallback((controller) => {
    twitchRef.current = controller;
    setTwitchControllable(Boolean(controller?.play && controller?.pause));
  }, []);

  /** The stage reports what the embed is actually doing. */
  const reportTwitchState = useCallback((state, message = null) => {
    setStatus((current) => {
      // Only the loaded Twitch channel may move the engine's state.
      if (nowPlayingRef.current?.source !== TWITCH) return current;
      return state;
    });
    if (message !== null) setError(message);
  }, []);

  const togglePlay = useCallback(() => {
    const loaded = nowPlayingRef.current;
    if (!loaded) return;

    if (loaded.source === TWITCH) {
      if (!twitchRef.current?.play) return;
      if (status === 'playing') {
        twitchRef.current.pause();
        setStatus('paused');
      } else {
        twitchRef.current.play();
      }
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;

    if (status === 'playing') {
      audio.pause();
      setStatus('paused');
      return;
    }

    // A live stream resumed after a pause should jump to *now*, not to
    // wherever the buffer stalled, so re-attach the source rather than
    // calling play() on a stale buffer.
    playStation(loaded.station);
  }, [playStation, status]);

  /* ----------------------------------------------------------- the dial */

  const registerBand = useCallback((owner, band) => {
    const bands = bandsRef.current;
    if (band) bands.set(owner, band);
    else bands.delete(owner);
    // There is only ever one view on screen; the most recent registration is it.
    let latest = null;
    for (const value of bands.values()) latest = value;
    pageBandRef.current = latest;
    if (latest) lastBandRef.current = latest;
    setPageBand(latest);
  }, []);

  /** The view's own list, else the last list tuned in from, else everything. */
  const currentBand = useCallback(() => {
    return (
      pageBandRef.current ??
      lastBandRef.current ?? {
        key: 'all',
        label: 'All stations',
        entries: stations.map((station) => ({ id: station.id, source: RADIO, station })),
      }
    );
  }, [stations]);

  const playEntry = useCallback(
    (entry) => {
      if (!entry) return;
      if (entry.source === TWITCH) playChannel(entry.channel);
      else playStation(entry.station);
    },
    [playChannel, playStation],
  );

  const step = useCallback(
    (direction) => {
      const band = currentBand();
      if (!band || band.entries.length === 0) return;
      const currentId = entryId(nowPlayingRef.current);
      const count = band.entries.length;
      const index = band.entries.findIndex((entry) => entry.id === currentId);
      // Off the band — tuned in from somewhere else, say — so next starts at
      // the top and previous at the end.
      const target =
        index === -1
          ? band.entries[direction === 1 ? 0 : count - 1]
          : band.entries[(index + direction + count) % count];
      if (!target || target.id === currentId) return;
      playEntry(target);
    },
    [currentBand, playEntry],
  );

  const nextStation = useCallback(() => step(1), [step]);
  const prevStation = useCallback(() => step(-1), [step]);

  const shuffle = useCallback(() => {
    const band = currentBand();
    if (!band || band.entries.length === 0) return;
    const currentId = entryId(nowPlayingRef.current);

    const pass = shuffleRef.current;
    if (pass.key !== band.key || pass.remaining.length === 0) {
      // A fresh pass: every entry on the band but the one playing, dealt in a
      // random order and consumed one press at a time, so nothing comes round
      // again until the whole band has been heard.
      const pool = band.entries.filter((entry) => entry.id !== currentId);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      shuffleRef.current = { key: band.key, remaining: pool };
    }

    let target = shuffleRef.current.remaining.shift();
    // The listener may have tuned to a dealt entry by hand in the meantime.
    while (target && target.id === currentId) {
      target = shuffleRef.current.remaining.shift();
    }
    playEntry(target);
  }, [currentBand, playEntry]);

  const band = pageBand ?? lastBandRef.current ?? null;

  const position = useMemo(() => {
    if (!band || !nowPlaying) return null;
    const index = band.entries.findIndex((entry) => entry.id === entryId(nowPlaying));
    if (index === -1) return null;
    return { index, count: band.entries.length, label: band.label };
  }, [band, nowPlaying]);

  /* ------------------------------------------------------------ metadata */

  useEffect(() => {
    let reconnectAttempts = 0;
    let reconnectTimeout = null;
    let isUnmounted = false;

    const connectWebSocket = () => {
      if (isUnmounted) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = import.meta.env.DEV ? 'localhost:3001' : window.location.host;
      wsRef.current = new WebSocket(`${protocol}//${host}`);

      wsRef.current.onopen = () => {
        reconnectAttempts = 0;
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'metadata') {
            setMetadata({
              artist: data.artist || '',
              title: data.title || '',
              artwork: data.artwork || null,
            });
          } else if (data.type === 'state' && data.metadata) {
            setMetadata(data.metadata);
          } else if (data.type === 'radio-command') {
            if (data.action === 'play' && data.stationId) {
              const station = DEFAULT_STATIONS.find((s) => s.id === data.stationId);
              if (station) playStation(station);
            } else if (data.action === 'stop') {
              stop();
            }
          } else if (data.type === 'switch-tab') {
            if (data.tab && [RADIO, TWITCH, 'spotify', 'mixcloud'].includes(data.tab)) {
              setActiveTab(data.tab);
            }
          }
        } catch (e) {
          console.error('WebSocket message error:', e);
        }
      };

      wsRef.current.onclose = () => {
        if (isUnmounted) return;
        // Exponential backoff: 3s, 6s, 12s, 24s, max 60s.
        const delay = Math.min(3000 * 2 ** reconnectAttempts, 60000);
        reconnectAttempts++;
        reconnectTimeout = setTimeout(connectWebSocket, delay);
      };

      wsRef.current.onerror = (e) => {
        console.error('WebSocket error:', e);
      };
    };

    connectWebSocket();

    return () => {
      isUnmounted = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
    // playStation and stop are stable enough for the lifetime of the socket;
    // re-opening it on every status change would drop metadata mid-track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------- OS media controls */

  // Next and previous on a keyboard or headset turn the same dial as the bar.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !nowPlaying) return;

    const name =
      nowPlaying.source === TWITCH
        ? nowPlaying.channel.displayName || nowPlaying.channel.login
        : nowPlaying.station.name;

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: metadata.title || name,
      artist: metadata.artist || name,
      album: 'LyraPod',
    });
    navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';

    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('stop', stop);
    navigator.mediaSession.setActionHandler('nexttrack', nextStation);
    navigator.mediaSession.setActionHandler('previoustrack', prevStation);

    return () => {
      for (const action of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack']) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [nowPlaying, metadata, status, togglePlay, stop, nextStation, prevStation]);

  /* ---------------------------------------------------------------- api */

  const currentStation = nowPlaying?.source === RADIO ? nowPlaying.station : null;
  const currentChannel = nowPlaying?.source === TWITCH ? nowPlaying.channel : null;

  const value = useMemo(
    () => ({
      stations,
      nowPlaying,
      currentStation,
      currentChannel,
      status,
      error,
      isPlaying,
      metadata,
      volume,
      elapsed,
      activeTab,
      showScreensaver,
      band,
      position,
      twitchControllable,
      setVolume,
      setActiveTab,
      playStation,
      playChannel,
      stop,
      togglePlay,
      nextStation,
      prevStation,
      shuffle,
      registerBand,
      registerTwitchPlayer,
      reportTwitchState,
      dismissScreensaver,
      resetActivity,
      triggerScreensaver,
    }),
    [
      stations,
      nowPlaying,
      currentStation,
      currentChannel,
      status,
      error,
      isPlaying,
      metadata,
      volume,
      elapsed,
      activeTab,
      showScreensaver,
      band,
      position,
      twitchControllable,
      playStation,
      playChannel,
      stop,
      togglePlay,
      nextStation,
      prevStation,
      shuffle,
      registerBand,
      registerTwitchPlayer,
      reportTwitchState,
      dismissScreensaver,
      resetActivity,
      triggerScreensaver,
    ],
  );

  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>;
}

export function useRadio() {
  const context = useContext(RadioContext);
  if (!context) {
    throw new Error('useRadio must be used within a RadioProvider');
  }
  return context;
}
