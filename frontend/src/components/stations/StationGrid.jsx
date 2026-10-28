import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRadio } from '../../contexts/RadioContext';
import { useBand } from '../../hooks/useBand';
import { useStationTaps } from '../../hooks/useStationTaps';
import { toRadioEntries } from '../../lib/band';
import { GENRES } from '../../config/genres';
import GenreRail, { GenreStrip } from './GenreRail';
import StationCard from './StationCard';
import { classNames } from '../../lib/format';

/**
 * The station index.
 *
 * The genre rail filters, the sort orders, and whatever is listed *is the
 * dial*: next, previous and shuffle step through exactly these stations in
 * exactly this order, so narrowing to Jazz turns the transport into a jazz
 * tuner without a separate control for it.
 *
 * Taps is the default order. On a catalogue nobody has played yet every count
 * is zero and it reads exactly as A-Z; it becomes the kitchen's own order as
 * the kitchen uses it.
 */
export default function StationGrid() {
  const { stations, nowPlaying, status, metadata, playStation } = useRadio();
  const { taps, loaded: tapsLoaded, recordTap } = useStationTaps();
  const [genre, setGenre] = useState(null);
  const [sort, setSort] = useState('taps');

  const genreNames = useMemo(
    () => new Map(GENRES.map((entry) => [entry.slug, entry.name])),
    [],
  );

  // Ordering reads a snapshot of the counts rather than the live ones. A tap
  // raises its station's count, and re-sorting the grid under the finger that
  // just tapped would move every other cell while the stream is still
  // starting. The snapshot is retaken whenever the view changes, so the new
  // order is waiting the next time you pick a sort or a genre.
  const latestTaps = useRef(taps);
  useEffect(() => {
    latestTaps.current = taps;
  }, [taps]);

  const [ranking, setRanking] = useState(taps);
  useEffect(() => {
    setRanking(latestTaps.current);
  }, [sort, genre, tapsLoaded]);

  const counts = useMemo(() => {
    const tally = new Map();
    for (const station of stations) {
      for (const slug of station.genres ?? []) {
        tally.set(slug, (tally.get(slug) ?? 0) + 1);
      }
    }
    return tally;
  }, [stations]);

  const unfiled = useMemo(
    () => stations.filter((station) => !station.genres?.length).length,
    [stations],
  );

  const visible = useMemo(() => {
    const filtered =
      genre === null
        ? stations
        : genre === 'unfiled'
          ? stations.filter((station) => !station.genres?.length)
          : stations.filter((station) => station.genres?.includes(genre));

    // Named 'place' rather than 'country' because that is the string shown:
    // stations whose place soundtap never established sort to the end rather
    // than under an invented heading.
    if (sort === 'place') {
      return [...filtered].sort((a, b) => {
        if (!a.place) return b.place ? 1 : 0;
        if (!b.place) return -1;
        return a.place.localeCompare(b.place, 'en', { sensitivity: 'base' })
          || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
      });
    }

    // Most chosen first. Everything untapped keeps its alphabetical order
    // rather than falling into an arbitrary one, so the tail of the list is
    // still something you can read down.
    if (sort === 'taps') {
      return [...filtered].sort(
        (a, b) =>
          (ranking[b.id] ?? 0) - (ranking[a.id] ?? 0)
          || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
      );
    }

    return filtered;
  }, [stations, genre, sort, ranking]);

  const band = useMemo(
    () => ({
      key: `stations:${genre ?? 'all'}:${sort}`,
      label: genre === null
        ? 'All stations'
        : genre === 'unfiled'
          ? 'Unfiled'
          : (genreNames.get(genre) ?? genre),
      entries: toRadioEntries(visible),
    }),
    [visible, genre, sort, genreNames],
  );
  useBand(band);

  const loadedId = nowPlaying?.station?.id ?? null;

  // A tap on the station already playing is a pause, and is not counted: the
  // number under Taps is how often you chose a station, not how often you
  // touched its cell. Stepping the dial is not a tap either, for the same
  // reason - the label would stop being true.
  const handlePlay = useCallback(
    (station) => {
      const pausing = loadedId === station.id && status === 'playing';
      if (!pausing) recordTap(station.id);
      playStation(station);
    },
    [loadedId, status, recordTap, playStation],
  );

  if (!stations.length) {
    return (
      <div className="panel m-4 p-8 text-center">
        <p className="stave-label">No stations</p>
        <p className="mt-2 text-sm" style={{ color: 'var(--chalk-2)' }}>
          The station catalogue could not be loaded.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 gap-px" style={{ background: 'var(--ink-3)' }}>
      {/* The rail gets its own column where there is room for one. */}
      <aside
        className="hidden w-[208px] flex-shrink-0 lg:block"
        style={{ background: 'var(--ink-2)' }}
      >
        <GenreRail
          genres={GENRES}
          counts={counts}
          unfiled={unfiled}
          active={genre}
          onSelect={setGenre}
          total={stations.length}
        />
      </aside>

      <section
        aria-label="Stations"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ background: 'var(--ink)' }}
      >
        <div className="lg:hidden">
          <GenreStrip
            genres={GENRES}
            counts={counts}
            unfiled={unfiled}
            active={genre}
            onSelect={setGenre}
            total={stations.length}
          />
        </div>

        <header className="flex flex-shrink-0 items-center justify-between gap-3 px-4 py-2.5 seam-b">
          <p className="min-w-0 truncate">
            <span className="stave-label">{band.label}</span>
            <span className="ml-2 font-mono text-[12px] tnum" style={{ color: 'var(--chalk-3)' }}>
              {visible.length}
            </span>
          </p>

          <div className="flex flex-shrink-0 items-center gap-px" role="group" aria-label="Order">
            {[
              ['taps', 'Taps'],
              ['name', 'A–Z'],
              ['place', 'By place'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                aria-pressed={sort === key}
                className="tap px-3 text-[13px]"
                style={{
                  background: sort === key ? 'var(--ink-3)' : 'transparent',
                  color: sort === key ? 'var(--chalk)' : 'var(--chalk-2)',
                  border: '1px solid var(--ink-3)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {visible.length === 0 ? (
          <p className="p-8 text-center text-sm" style={{ color: 'var(--chalk-2)' }}>
            No station in the catalogue carries this genre.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ul
              className={classNames(
                'grid gap-px',
                'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4',
              )}
              style={{ background: 'var(--ink-3)' }}
            >
              {visible.map((station) => {
                const loaded = loadedId === station.id;
                return (
                  <li key={station.id} className="flex">
                    <StationCard
                      station={station}
                      loaded={loaded}
                      live={loaded && status === 'playing'}
                      connecting={loaded && status === 'connecting'}
                      metadata={metadata}
                      onPlay={handlePlay}
                      highlightGenre={genre === 'unfiled' ? null : genre}
                      genreNames={genreNames}
                      // The count is shown only where it is doing the
                      // ordering, and the live number is used rather than the
                      // snapshot: the tap you just made reads back at once,
                      // while its position waits for the next view.
                      taps={sort === 'taps' ? (taps[station.id] ?? 0) : 0}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
