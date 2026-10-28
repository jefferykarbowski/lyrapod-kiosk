import { useEffect, useMemo, useState } from 'react';
import { useRadio } from '../../contexts/RadioContext';
import { useBand } from '../../hooks/useBand';
import { toChannelEntries, TWITCH } from '../../lib/band';
import { useKeyboard } from '../../contexts/KeyboardContext';
import { useTwitchChannels } from '../../hooks/useTwitchChannels';
import TwitchStage from './TwitchStage';
import VirtualKeyboard from '../VirtualKeyboard';
import { Block, Comb } from '../marks/Marks';
import { classNames, compactNumber } from '../../lib/format';

/**
 * The Twitch stave.
 *
 * Built on the same grammar as the station index — a list of cells, the live
 * one marked by the source colour on its seam, and whatever is listed is the
 * dial. What differs is that a channel is video, so the chosen one occupies a
 * stage above the list instead of playing invisibly.
 *
 * Live state is reported, never assumed. Without a client id and secret the
 * backend cannot ask Twitch anything, and a channel then reads "live state
 * unknown" rather than showing as offline.
 */
export default function TwitchTab() {
  const { nowPlaying, status, playChannel } = useRadio();
  const { channels, configured, notice, error, busy, addChannel, removeChannel } =
    useTwitchChannels({ poll: true });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [showKeyboard, setShowKeyboard] = useState(false);
  const { setIsKeyboardOpen } = useKeyboard();

  useEffect(() => {
    setIsKeyboardOpen(showKeyboard);
  }, [showKeyboard, setIsKeyboardOpen]);

  const list = useMemo(() => channels ?? [], [channels]);

  // Live channels first, then the rest, each group alphabetical. The dial
  // follows this order, so next steps through what is actually on air before
  // it reaches anything that is not.
  const ordered = useMemo(() => {
    const rank = (channel) => (channel.live === true ? 0 : channel.live === null ? 1 : 2);
    return [...list].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.displayName || a.login).localeCompare(b.displayName || b.login, 'en', {
          sensitivity: 'base',
        }),
    );
  }, [list]);

  const band = useMemo(
    () => ({
      key: 'twitch',
      label: 'Twitch',
      // A channel Twitch says is off air is not a stop on the dial; stepping
      // onto it would only produce an error.
      entries: toChannelEntries(ordered.filter((channel) => channel.live !== false)),
    }),
    [ordered],
  );
  useBand(band);

  const loaded = nowPlaying?.source === TWITCH ? nowPlaying.channel : null;

  async function submit() {
    const value = draft.trim();
    if (!value) return;
    if (await addChannel(value)) {
      setDraft('');
      setAdding(false);
      setShowKeyboard(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The stage. Nothing is loaded until a channel is chosen, and an empty
          stage says so rather than showing a black rectangle. */}
      <div
        className="flex-shrink-0 seam-b"
        style={{ background: 'var(--ink)', height: loaded ? '52%' : 0, transition: 'height 240ms var(--draw)' }}
      >
        {/* Keyed by channel, so choosing another one remounts the embed rather
            than asking a live player to change channel under itself. */}
        {loaded && <TwitchStage key={loaded.login} channel={loaded} />}
      </div>

      <div className="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--ink)' }}>
        <header className="flex flex-shrink-0 items-center justify-between gap-3 px-4 py-2.5 seam-b">
          <p className="min-w-0 truncate">
            <span className="stave-label">Channels</span>
            <span className="ml-2 font-mono text-[12px] tnum" style={{ color: 'var(--chalk-3)' }}>
              {list.length}
            </span>
            {!configured && list.length > 0 && (
              <span className="ml-3 text-[12.5px]" style={{ color: 'var(--chalk-3)' }}>
                Live state unknown — no Twitch credentials set
              </span>
            )}
          </p>

          <button
            onClick={() => {
              setAdding((open) => !open);
              setShowKeyboard(false);
            }}
            className="tap flex-shrink-0 px-3 text-[13px]"
            style={{
              border: '1px solid var(--ink-3)',
              color: adding ? 'var(--sig-violet)' : 'var(--chalk-2)',
            }}
          >
            {adding ? 'Cancel' : 'Add channel'}
          </button>
        </header>

        {adding && (
          <div className="flex-shrink-0 px-4 py-3 seam-b" style={{ background: 'var(--ink-2)' }}>
            <label className="stave-label block" style={{ fontSize: 11 }} htmlFor="twitch-login">
              Channel name or twitch.tv link
            </label>
            <div className="mt-2 flex gap-px">
              <input
                id="twitch-login"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={() => setShowKeyboard(true)}
                onKeyDown={(event) => event.key === 'Enter' && submit()}
                autoComplete="off"
                spellCheck="false"
                placeholder="lofigirl"
                className="min-w-0 flex-1 px-3 py-2.5 text-[15px] outline-none"
                style={{
                  background: 'var(--ink)',
                  border: '1px solid var(--ink-4)',
                  color: 'var(--chalk)',
                }}
              />
              <button
                onClick={submit}
                disabled={busy || !draft.trim()}
                className="tap px-4 text-[14px] font-semibold disabled:opacity-30"
                style={{ background: 'var(--sig-violet)', color: 'var(--ink)' }}
              >
                Add
              </button>
            </div>
            {error && (
              <p role="alert" className="mt-2 text-[12.5px]" style={{ color: 'var(--sig-amber)' }}>
                {error}
              </p>
            )}
          </div>
        )}

        {notice && (
          <p
            role="status"
            className="flex-shrink-0 px-4 py-2 text-[12.5px] seam-b"
            style={{ color: 'var(--sig-amber)', background: 'var(--ink-2)' }}
          >
            {notice}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {channels === null ? (
            <p className="p-8 text-center text-sm" style={{ color: 'var(--chalk-3)' }}>
              Reading the channel list…
            </p>
          ) : list.length === 0 ? (
            <EmptyState configured={configured} onAdd={() => setAdding(true)} />
          ) : (
            <ul className="grid gap-px sm:grid-cols-2 xl:grid-cols-3" style={{ background: 'var(--ink-3)' }}>
              {ordered.map((channel) => (
                <li key={channel.login} className="flex">
                  <ChannelCard
                    channel={channel}
                    loaded={loaded?.login === channel.login}
                    live={loaded?.login === channel.login && status === 'playing'}
                    onPlay={playChannel}
                    onRemove={removeChannel}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {showKeyboard && (
        <VirtualKeyboard
          initialValue={draft}
          onChange={setDraft}
          onClose={() => setShowKeyboard(false)}
        />
      )}
    </div>
  );
}

function ChannelCard({ channel, loaded, live, onPlay, onRemove }) {
  const offline = channel.live === false;
  const unknown = channel.live === null;

  return (
    <div
      className={classNames('cell relative flex min-h-[104px] w-full items-start gap-3 p-3', loaded && 'cell--live')}
    >
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-0 top-0 transition-all duration-300"
        style={{ width: loaded ? 3 : 0, background: 'var(--sig-violet)' }}
      />

      <button
        onClick={() => onPlay(channel)}
        disabled={offline}
        aria-current={loaded ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-start gap-3 text-left disabled:cursor-not-allowed"
      >
        <span
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden"
          style={{ border: '1px solid var(--ink-4)', opacity: offline ? 0.45 : 1 }}
        >
          {channel.profileImage ? (
            <img src={channel.profileImage} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <span className="block h-6 w-7" style={{ color: 'var(--sig-violet)' }}>
              <Block seed={channel.login} rows={3} className="h-full w-full" />
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[15px] font-semibold leading-tight"
            style={{ color: offline ? 'var(--chalk-2)' : 'var(--chalk)' }}
          >
            {channel.displayName || channel.login}
          </span>

          <span className="mt-0.5 flex items-center gap-2 text-[12.5px]">
            {live ? (
              <>
                <span className="block h-3.5 w-4" style={{ color: 'var(--sig-violet)' }}>
                  <Comb seed={channel.login} bars={4} animated className="h-full w-full" height={14} />
                </span>
                <span style={{ color: 'var(--sig-violet)' }}>Playing</span>
              </>
            ) : channel.live === true ? (
              <span style={{ color: 'var(--sig-violet)' }}>
                Live
                {channel.viewers != null && (
                  <span className="ml-1.5 font-mono tnum" style={{ color: 'var(--chalk-3)' }}>
                    {compactNumber(channel.viewers)}
                  </span>
                )}
              </span>
            ) : offline ? (
              <span style={{ color: 'var(--chalk-3)' }}>Off air</span>
            ) : (
              <span style={{ color: 'var(--chalk-3)' }}>Live state unknown</span>
            )}
          </span>

          {channel.title && (
            <span className="mt-1 block truncate text-[12.5px]" style={{ color: 'var(--chalk-2)' }}>
              {channel.title}
            </span>
          )}
          {channel.game && (
            <span className="mt-0.5 block truncate text-[12px]" style={{ color: 'var(--chalk-3)' }}>
              {channel.game}
            </span>
          )}
          {unknown && !channel.title && (
            <span className="mt-1 block text-[12px]" style={{ color: 'var(--chalk-3)' }}>
              Tap to try it
            </span>
          )}
        </span>
      </button>

      <button
        onClick={() => onRemove(channel.login)}
        aria-label={`Remove ${channel.displayName || channel.login}`}
        className="tap flex flex-shrink-0 items-center justify-center"
        style={{ color: 'var(--chalk-3)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function EmptyState({ configured, onAdd }) {
  return (
    <div className="p-8 text-center">
      <span className="mx-auto block h-10 w-16" style={{ color: 'var(--sig-violet)', opacity: 0.5 }}>
        <Block seed="twitch-empty" rows={3} className="h-full w-full" />
      </span>
      <p className="stave-label mt-4">No channels</p>
      <p className="mx-auto mt-2 max-w-sm text-[13.5px]" style={{ color: 'var(--chalk-2)' }}>
        Add a Twitch channel and it plays here on the stage.
        {!configured && ' Set a Twitch client id and secret in the backend config to also see which channels are live.'}
      </p>
      <button
        onClick={onAdd}
        className="tap mt-4 px-4 text-[14px] font-semibold"
        style={{ background: 'var(--sig-violet)', color: 'var(--ink)' }}
      >
        Add a channel
      </button>
    </div>
  );
}
