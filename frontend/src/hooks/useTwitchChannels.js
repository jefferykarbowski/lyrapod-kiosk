import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The listener's Twitch channels, with whatever the backend could learn about
 * them.
 *
 * `configured` is false when no client id and secret are set, and then `live`
 * is null on every channel: the kiosk cannot tell whether a channel is on air,
 * and says so rather than showing every tile as offline. Channels still play
 * in that state — the embed needs no credentials.
 */
export function useTwitchChannels({ poll = false } = {}) {
  const [channels, setChannels] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((payload) => {
    if (!mounted.current) return;
    setChannels(payload.channels ?? []);
    setConfigured(Boolean(payload.configured));
    setNotice(payload.error ?? null);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/twitch/status');
      if (!response.ok) throw new Error(`status ${response.status}`);
      apply(await response.json());
      if (mounted.current) setError(null);
    } catch {
      if (mounted.current) {
        setError('Could not reach the kiosk backend.');
        setChannels((current) => current ?? []);
      }
    }
  }, [apply]);

  useEffect(() => {
    load();
    if (!poll) return;
    // Live state changes on the order of minutes, not seconds, and the backend
    // caches Helix for 30s regardless, so a minute here is honest and cheap.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load, poll]);

  const addChannel = useCallback(
    async (login) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch('/api/twitch/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login }),
        });
        const payload = await response.json();
        if (!response.ok) {
          if (mounted.current) setError(payload.error ?? 'Could not add that channel.');
          return false;
        }
        apply(payload);
        return true;
      } catch {
        if (mounted.current) setError('Could not reach the kiosk backend.');
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [apply],
  );

  const removeChannel = useCallback(
    async (login) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/twitch/channels/${encodeURIComponent(login)}`, {
          method: 'DELETE',
        });
        const payload = await response.json();
        if (!response.ok) {
          if (mounted.current) setError(payload.error ?? 'Could not remove that channel.');
          return false;
        }
        apply(payload);
        return true;
      } catch {
        if (mounted.current) setError('Could not reach the kiosk backend.');
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [apply],
  );

  return { channels, configured, notice, error, busy, addChannel, removeChannel, reload: load };
}

export default useTwitchChannels;
