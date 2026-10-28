import { useMemo, useState } from 'react';
import { useRadio } from '../../contexts/RadioContext';
import { useBand } from '../../hooks/useBand';
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
 */
export default function StationGrid() {
  const { stations, nowPlaying, status, metadata, playStation } = useRadio();
  const [genre, setGenre] = useState(null);
  const [sort, setSort] = useState('name');

  const genreNames = useMemo(
    () => new Map(GENRES.map((entry) => [entry.slug, entry.name])),
    [],
  );

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
    return filtered;
  }, [stations, genre, sort]);

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
                      onPlay={playStation}
                      highlightGenre={genre === 'unfiled' ? null : genre}
                      genreNames={genreNames}
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
