import { useCallback, useEffect, useState } from 'react';

/**
 * How often each station has been chosen from the index.
 *
 * The counts belong to the device, so they are read from the backend and
 * survive a reload of the shell. A tap is applied locally at once and posted
 * without waiting: this kiosk is the only thing writing them, so a round trip
 * would only make the number lag behind the finger that caused it. A post
 * that fails costs that one count at the next reload, never the total.
 *
 * `loaded` reports that the server has answered, which is not the same as
 * there being any counts: a catalogue nobody has played yet answers `{}`.
 */
export function useStationTaps() {
  const [taps, setTaps] = useState({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/stations/taps')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.taps) setTaps(data.taps);
        setLoaded(true);
      })
      .catch(() => {
        // No counts is a usable state: every station reads as untapped and
        // the order falls back to the alphabet.
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const recordTap = useCallback((id) => {
    if (!id) return;
    setTaps((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
    fetch(`/api/stations/taps/${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {});
  }, []);

  return { taps, loaded, recordTap };
}
