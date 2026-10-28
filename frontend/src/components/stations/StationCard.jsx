import { useState } from 'react';
import { StationMark, Comb } from '../marks/Marks';
import { classNames, initialsOf, stationLines } from '../../lib/format';

/**
 * A station, as the unit the index is built from.
 *
 * Reads top to bottom as four separate claims, each from its own record and
 * each omitted when it is not known: who the station is, where it is, what it
 * is broadcasting right now, and what it plays. The catalogue knows a place
 * for 225 of the 255 and a genre for 93, so most cards are shorter than this
 * one could be — an empty line is better than a filled-in guess.
 *
 * The live cell is marked by the source colour on its left seam and by its
 * mark moving. Never by a fill or a glow.
 */
export default function StationCard({
  station,
  live,
  loaded,
  connecting,
  metadata,
  onPlay,
  highlightGenre,
  genreNames,
}) {
  const [artworkFailed, setArtworkFailed] = useState(false);
  const { place, tagline } = stationLines(station);

  // The now-playing line is what is actually coming out of the speaker, so it
  // belongs only to the cell that is sounding.
  const track = live && (metadata?.title || metadata?.artist) ? metadata : null;

  const genres = station.genres ?? [];
  const shown = highlightGenre
    ? // Pinned first, so a filtered index never lists a station whose reason
      // for being there is cut off by the three-chip limit.
      [...genres].sort(
        (a, b) => Number(b === highlightGenre) - Number(a === highlightGenre),
      )
    : genres;

  return (
    <button
      onClick={() => onPlay(station)}
      aria-current={loaded ? 'true' : undefined}
      className={classNames(
        'cell group relative flex min-h-[112px] w-full flex-col items-stretch p-3 text-left',
        loaded && 'cell--live',
      )}
    >
      {/* Live seam — the only place the source colour appears in a cell. */}
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 top-0 transition-all duration-300"
        style={{ width: loaded ? 3 : 0, background: 'var(--sig-green)' }}
      />

      <span className="flex items-start gap-3">
        <StationPlate station={station} live={live} failed={artworkFailed} onFail={() => setArtworkFailed(true)} />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-tight" style={{ color: 'var(--chalk)' }}>
            {station.name}
          </span>

          {place && (
            <span className="mt-0.5 block truncate text-[13px]" style={{ color: 'var(--chalk-2)' }}>
              {place}
            </span>
          )}

          {tagline && (
            <span className="mt-0.5 block truncate text-[12px]" style={{ color: 'var(--chalk-3)' }}>
              {tagline}
            </span>
          )}
        </span>

        {/* Playing: a live comb, the radio mark, rather than an icon badge. */}
        {live && (
          <span
            aria-label="Playing"
            className="block h-5 w-6 flex-shrink-0"
            style={{ color: 'var(--sig-green)' }}
          >
            <Comb seed={station.id} bars={5} animated className="h-full w-full" height={20} />
          </span>
        )}

        {connecting && !live && (
          <span className="stave-label flex-shrink-0" style={{ fontSize: 10, color: 'var(--sig-green)' }}>
            Tuning
          </span>
        )}
      </span>

      {/* What is on air, read from the stream's own metadata. Given its own row
          because it is the most current thing on the cell and changes while
          you are looking at it. */}
      {track && (
        <span className="mt-2 block min-w-0 border-t pt-2" style={{ borderColor: 'var(--ink-4)' }}>
          <span className="block truncate text-[12.5px] leading-snug" style={{ color: 'var(--chalk)' }}>
            {track.title || track.artist}
          </span>
          {track.title && track.artist && (
            <span className="block truncate text-[12px]" style={{ color: 'var(--chalk-3)' }}>
              {track.artist}
            </span>
          )}
        </span>
      )}

      {shown.length > 0 && (
        <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-2">
          {shown.slice(0, 3).map((slug) => (
            <span
              key={slug}
              className="text-[11.5px]"
              style={{
                color: slug === highlightGenre ? 'var(--chalk-2)' : 'var(--chalk-3)',
              }}
            >
              {genreNames?.get(slug) ?? slug}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * Station identity: its real artwork where one exists, its own drawn mark
 * otherwise. 48 of the 255 have no artwork, and a mark derived from the
 * station's name is a better answer there than a generic placeholder tile.
 * Initials stand in only where even the mark would be ambiguous — a logo file
 * that exists but fails to decode.
 */
function StationPlate({ station, live, failed, onFail }) {
  const showArtwork = station.logo && !failed;

  return (
    <span
      className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden"
      style={{ border: '1px solid var(--ink-4)' }}
    >
      {showArtwork ? (
        <img
          src={station.logo}
          alt=""
          className="h-full w-full object-contain p-0.5"
          loading="lazy"
          decoding="async"
          onError={onFail}
        />
      ) : failed ? (
        <span className="font-mono text-[11px] font-bold" style={{ color: 'var(--chalk-3)' }}>
          {initialsOf(station.name)}
        </span>
      ) : (
        <span className="block h-6 w-8" style={{ color: 'var(--sig-green)' }}>
          <StationMark name={station.name} playing={live} className="h-full w-full" />
        </span>
      )}
    </span>
  );
}
