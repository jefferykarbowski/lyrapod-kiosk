import { classNames } from '../../lib/format';

/**
 * The genre rail, inherited from soundtap and kept deliberately dense: a name,
 * a count, and a bar scaled against the largest genre, so the shape of the
 * whole catalogue is legible without reading a single number.
 *
 * Two departures from the original. There is no colour chip: in this interface
 * colour identifies a source, and thirty-one genre hues would spend it on
 * ornament. And "Unfiled" is a real row rather than a silent omission —
 * soundtap can leave an unclassified station to be found by search, but a
 * kiosk rail is the only way in, and 162 of the 255 carry no genre at all.
 */
export default function GenreRail({ genres, counts, unfiled, active, onSelect, total }) {
  const largest = Math.max(
    unfiled,
    ...genres.map((genre) => counts.get(genre.slug) ?? 0),
  );

  const rows = [
    { slug: null, name: 'All stations', count: total },
    ...genres
      .filter((genre) => (counts.get(genre.slug) ?? 0) > 0)
      .map((genre) => ({ slug: genre.slug, name: genre.name, count: counts.get(genre.slug) })),
    ...(unfiled > 0 ? [{ slug: 'unfiled', name: 'Unfiled', count: unfiled }] : []),
  ];

  return (
    <nav aria-label="Genres" className="flex h-full flex-col">
      <p className="stave-label flex-shrink-0 px-3 py-2.5 seam-b" aria-hidden="true">
        Genres
      </p>

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.map((row) => {
          const isActive = row.slug === active;
          const share = largest > 0 ? ((row.count ?? 0) / largest) * 100 : 0;

          return (
            <li key={row.slug ?? 'all'}>
              <button
                onClick={() => onSelect(row.slug)}
                aria-current={isActive ? 'true' : undefined}
                className={classNames(
                  'relative flex w-full items-center gap-2 overflow-hidden px-3 text-left text-[13.5px] transition-colors duration-150',
                  // Rail rows are a scanning list, not a transport: 36px keeps
                  // thirty-odd genres reachable without scrolling past the
                  // fold, and the whole row is the target.
                  'min-h-[36px]',
                )}
                style={{
                  background: isActive ? 'var(--ink-3)' : 'transparent',
                  color: isActive ? 'var(--chalk)' : 'var(--chalk-2)',
                }}
              >
                {/* Share-of-catalogue bar, sitting behind the label. Chalk,
                    not colour: this is quantity, not identity. */}
                {row.slug !== null && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 transition-opacity duration-150"
                    style={{
                      width: `${share}%`,
                      background: isActive ? 'var(--sig-green)' : 'var(--chalk)',
                      opacity: isActive ? 0.14 : 0.07,
                    }}
                  />
                )}

                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{ background: 'var(--sig-green)' }}
                  />
                )}

                <span className="relative min-w-0 flex-1 truncate">{row.name}</span>
                <span className="relative font-mono text-[12px] tnum" style={{ color: 'var(--chalk-3)' }}>
                  {row.count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The same rail turned on its side, for a viewport too narrow to spare a
 * column. Stacked, thirty-one genres ran past the index itself.
 */
export function GenreStrip({ genres, counts, unfiled, active, onSelect, total }) {
  const rows = [
    { slug: null, name: 'All', count: total },
    ...genres
      .filter((genre) => (counts.get(genre.slug) ?? 0) > 0)
      .map((genre) => ({ slug: genre.slug, name: genre.name, count: counts.get(genre.slug) })),
    ...(unfiled > 0 ? [{ slug: 'unfiled', name: 'Unfiled', count: unfiled }] : []),
  ];

  return (
    <nav aria-label="Genres" className="overflow-x-auto seam-b">
      <ul className="flex items-stretch gap-px" style={{ background: 'var(--ink-3)' }}>
        {rows.map((row) => {
          const isActive = row.slug === active;
          return (
            <li key={row.slug ?? 'all'} className="flex-shrink-0">
              <button
                onClick={() => onSelect(row.slug)}
                aria-current={isActive ? 'true' : undefined}
                className="tap flex items-center gap-1.5 whitespace-nowrap px-3 text-[13px]"
                style={{
                  background: isActive ? 'var(--ink-3)' : 'var(--ink-2)',
                  color: isActive ? 'var(--sig-green)' : 'var(--chalk-2)',
                  boxShadow: isActive ? 'inset 0 2px 0 0 var(--sig-green)' : undefined,
                }}
              >
                {row.name}
                <span className="font-mono text-[11.5px] tnum" style={{ color: 'var(--chalk-3)' }}>
                  {row.count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
