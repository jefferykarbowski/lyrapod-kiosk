/** Presentation helpers. Nothing here touches the network or the audio engine. */

export function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

/** Seconds to `1:04:22` or `4:22`. */
export function duration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact counts: 1200 to "1.2k". */
export function compactNumber(value) {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
}

/**
 * The initials a station falls back to when it has no artwork. Three
 * characters at most, so the plate never has to shrink its type to fit.
 */
export function initialsOf(name = '') {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const letters = words.length > 1
    ? words.map((word) => word[0]).join('')
    : (words[0] ?? '');
  return letters.slice(0, 3).toUpperCase() || '—';
}

/**
 * The two text lines under a station's name.
 *
 * Place and tagline are different records of different things, and either may
 * be missing: soundtap knows a place for 225 of the 255 stations, while the
 * hand-written tagline exists for the ones LyraPod carried first. Where they
 * say the same thing, only one line is drawn.
 */
export function stationLines(station) {
  const place = station.place || null;
  const tagline = station.genre && station.genre !== place ? station.genre : null;
  return { place, tagline };
}
