/**
 * Source registry.
 *
 * Product principle: sources are data, never hardcoded tabs. Each entry is a
 * stave in the score — it can be switched off and reordered, and a new service
 * is added by appending here rather than by editing the navigation.
 *
 * `status` is deliberately explicit:
 *   'live'    — implemented and reachable
 *   'planned' — not built. Renders visibly unavailable. Never present as working.
 */

export const SOURCES = [
  {
    id: 'radio',
    label: 'Radio',
    legend: 'Freeform + community',
    color: 'var(--sig-green)',
    colorHex: '#3ff5a8',
    mark: 'comb',
    status: 'live',
  },
  {
    id: 'mixcloud',
    label: 'Mixcloud',
    legend: 'Sets + long-form',
    color: 'var(--sig-magenta)',
    colorHex: '#ff3d8b',
    mark: 'block',
    status: 'live',
  },
  {
    id: 'spotify',
    label: 'Spotify',
    legend: 'Library',
    color: 'var(--sig-amber)',
    colorHex: '#ffb03a',
    mark: 'block',
    status: 'live',
  },
  {
    id: 'twitch',
    label: 'Twitch',
    legend: 'Live channels',
    // Violet was held for "the next source". This is it.
    color: 'var(--sig-violet)',
    colorHex: '#a77bff',
    mark: 'block',
    status: 'live',
  },
  {
    id: 'apple',
    label: 'Apple Music',
    legend: 'Not connected',
    color: 'var(--chalk-3)',
    colorHex: '#7c7c76',
    mark: 'stipple',
    status: 'planned',
  },
  {
    id: 'amazon',
    label: 'Amazon Music',
    legend: 'Not connected',
    color: 'var(--sig-cyan)',
    colorHex: '#49d4ff',
    mark: 'stipple',
    status: 'planned',
  },
];

const STORAGE_KEY = 'lyrapod.sources.v1';

/** Default layout: live sources on, planned sources off, declaration order. */
function defaults() {
  return SOURCES.map((s, i) => ({
    id: s.id,
    order: i,
    enabled: s.status === 'live',
  }));
}

export function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const saved = JSON.parse(raw);

    // Merge rather than replace, so a source added in a later release appears
    // instead of vanishing for anyone with a stored layout.
    const bySaved = new Map(saved.map((s) => [s.id, s]));
    return SOURCES.map((s, i) => {
      const hit = bySaved.get(s.id);
      return {
        id: s.id,
        order: hit ? hit.order : i,
        enabled: hit ? hit.enabled : s.status === 'live',
      };
    });
  } catch {
    return defaults();
  }
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage unavailable (private mode, quota). The layout still works for
    // this session; losing persistence is not worth breaking the UI over.
  }
}

/** Sources joined to their stored layout, ordered, with metadata attached. */
export function resolveSources(layout) {
  const byId = new Map(SOURCES.map((s) => [s.id, s]));
  return layout
    .map((l) => ({ ...byId.get(l.id), ...l }))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function getSource(id) {
  return SOURCES.find((s) => s.id === id);
}
