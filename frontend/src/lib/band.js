/**
 * The dial's vocabulary.
 *
 * A *band* is an ordered list of stops that next, previous and shuffle step
 * through: the stations or channels listed on the view you are looking at, in
 * that view's order. A view hands one to the engine through `useBand`.
 *
 * These live outside RadioContext because they are plain data, and a context
 * module that also exports constants cannot hot-reload.
 */

/** Which engine plays a stop: the <audio> element, or the Twitch embed. */
export const RADIO = 'radio';
export const TWITCH = 'twitch';

/** An ordered station list becomes dial stops. */
export const toRadioEntries = (stations) =>
  stations.map((station) => ({ id: station.id, source: RADIO, station }));

/** The same, for Twitch channels. */
export const toChannelEntries = (channels) =>
  channels.map((channel) => ({ id: channel.login, source: TWITCH, channel }));

/** The id a stop is identified by, whichever source it belongs to. */
export const entryId = (nowPlaying) => {
  if (!nowPlaying) return null;
  return nowPlaying.source === TWITCH ? nowPlaying.channel.login : nowPlaying.station.id;
};
