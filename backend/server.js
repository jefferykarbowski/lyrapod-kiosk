import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import icy from 'icy';
import { parseString } from 'xml2js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, execFile, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Load config. config.json holds local secrets and is not tracked in git;
// every secret can also be supplied via environment variable, which wins.
let config = {};
try {
  const configPath = path.join(__dirname, 'config.json');
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Error loading config:', e);
}

const applyEnvOverrides = (cfg) => {
  const overrides = {
    weather: { apiKey: 'WEATHER_API_KEY', zipCode: 'WEATHER_ZIP', country: 'WEATHER_COUNTRY', units: 'WEATHER_UNITS' },
    news: { rssUrl: 'NEWS_RSS_URL' },
    lastfm: { apiKey: 'LASTFM_API_KEY' },
    spotify: { clientId: 'SPOTIFY_CLIENT_ID', clientSecret: 'SPOTIFY_CLIENT_SECRET', redirectUri: 'SPOTIFY_REDIRECT_URI' },
    mixcloud: { clientId: 'MIXCLOUD_CLIENT_ID', clientSecret: 'MIXCLOUD_CLIENT_SECRET', redirectUri: 'MIXCLOUD_REDIRECT_URI' },
  };

  for (const [section, keys] of Object.entries(overrides)) {
    for (const [key, envVar] of Object.entries(keys)) {
      if (process.env[envVar]) {
        cfg[section] = cfg[section] || {};
        cfg[section][key] = process.env[envVar];
      }
    }
  }
  return cfg;
};

config = applyEnvOverrides(config);

// Warn loudly at boot rather than failing mysteriously mid-OAuth.
for (const [service, keys] of Object.entries({
  weather: ['apiKey'],
  spotify: ['clientId', 'clientSecret'],
  mixcloud: ['clientId', 'clientSecret'],
})) {
  const missing = keys.filter((k) => !config[service]?.[k]);
  if (missing.length) {
    console.warn(`[config] ${service} missing: ${missing.join(', ')} — that feature will be disabled`);
  }
}

// Middleware
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// Fallback to index.html for SPA routing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// State
let currentMetadata = { artist: '', title: '', artwork: null };
let currentStationUrl = null;
let icyConnection = null;
let metadataInterval = null;

// Broadcast to all WebSocket clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Clean up search terms for better iTunes matches
function cleanSearchTerm(str) {
  if (!str) return '';
  return str
    // Remove show/DJ info patterns
    .replace(/\s+on\s+.*/i, '')           // "on Show Name"
    .replace(/\s+with\s+.*/i, '')         // "with DJ Name"
    .replace(/\s+from\s+.*/i, '')         // "from Album"
    .replace(/\([^)]*edit[^)]*\)/gi, '')  // "(DJ Edit)" etc
    .replace(/\([^)]*remix[^)]*\)/gi, '') // "(Remix)" keep for search
    .replace(/\([^)]*mix[^)]*\)/gi, '')   // "(Mix)"
    .replace(/\([^)]*live[^)]*\)/gi, '')  // "(Live)"
    .replace(/\[[^\]]*\]/g, '')           // [anything in brackets]
    .replace(/["']/g, '')                 // quotes
    .replace(/\s+/g, ' ')                 // multiple spaces
    .trim();
}

// Fetch artwork from iTunes
async function fetchArtwork(artist, title) {
  if (!artist && !title) return null;
  
  // Clean up the search terms
  const cleanArtist = cleanSearchTerm(artist);
  const cleanTitle = cleanSearchTerm(title);
  
  // Try different search strategies
  const searches = [
    `${cleanArtist} ${cleanTitle}`,           // Full search
    cleanArtist ? `${cleanArtist}` : null,    // Just artist
    cleanTitle ? `${cleanTitle}` : null,      // Just title
  ].filter(Boolean);

  for (const searchTerm of searches) {
    try {
      const query = encodeURIComponent(searchTerm.substring(0, 100)); // iTunes has query limits
      const url = `https://itunes.apple.com/search?term=${query}&media=music&limit=5`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.results && data.results.length > 0) {
        // Try to find best match
        const artwork = data.results[0].artworkUrl100?.replace('100x100', '600x600');
        if (artwork) {
          console.log('Artwork found for:', searchTerm);
          return artwork;
        }
      }
    } catch (e) {
      console.error('iTunes artwork fetch error:', e.message);
    }
  }
  
  console.log('No artwork found for:', cleanArtist, '-', cleanTitle);
  return null;
}

// Parse ICY metadata string
function parseMetadata(metaString) {
  if (!metaString) return null;
  
  let artist = '';
  let title = metaString;
  
  // Common formats:
  // "Artist - Title"
  // "Title by Artist on Show"
  // "Artist: Title"
  // "\"Title\" by Artist"
  
  // Handle quoted titles first: "Title" by Artist
  const quotedMatch = metaString.match(/^["'](.+?)["']\s+by\s+(.+)/i);
  if (quotedMatch) {
    title = quotedMatch[1].trim();
    artist = quotedMatch[2].trim();
  }
  // Handle "Title by Artist on Show" format
  else if (metaString.toLowerCase().includes(' by ')) {
    const parts = metaString.split(/\s+by\s+/i);
    title = parts[0].trim();
    artist = parts[1]?.trim() || '';
  }
  // Handle "Artist - Title" format
  else if (metaString.includes(' - ')) {
    const parts = metaString.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }
  // Handle "Artist: Title" format
  else if (metaString.includes(': ')) {
    const parts = metaString.split(': ');
    artist = parts[0].trim();
    title = parts.slice(1).join(': ').trim();
  }
  
  // Clean up artist - remove "on ShowName" suffix
  artist = artist.replace(/\s+on\s+.*/i, '').trim();
  
  console.log('Parsed metadata:', { artist, title, raw: metaString });
  
  return { artist, title };
}

// Connect to stream for ICY metadata
function connectToStream(streamUrl) {
  // Cleanup existing connection
  if (icyConnection) {
    try {
      icyConnection.destroy();
    } catch (e) {}
    icyConnection = null;
  }
  if (metadataInterval) {
    clearInterval(metadataInterval);
    metadataInterval = null;
  }

  if (!streamUrl) return;
  currentStationUrl = streamUrl;
  
  console.log('Connecting to stream for metadata:', streamUrl);

  // ICY only works with HTTP streams
  if (streamUrl.startsWith('https://')) {
    console.log('HTTPS stream - ICY metadata not available for:', streamUrl);
    // For HTTPS streams, we can't get ICY metadata directly
    // Clear any existing metadata and notify clients
    currentMetadata = { artist: '', title: '', artwork: null };
    broadcast({ type: 'metadata', ...currentMetadata });
    return;
  }

  icy.get(streamUrl, (res) => {
    icyConnection = res;
    console.log('ICY connection established');

    res.on('metadata', async (metadata) => {
      try {
        const icyData = icy.parse(metadata);
        const streamTitle = icyData.StreamTitle || '';
        console.log('ICY metadata received:', streamTitle);

        const parsed = parseMetadata(streamTitle);
        if (parsed && (parsed.artist !== currentMetadata.artist || parsed.title !== currentMetadata.title)) {
          currentMetadata = parsed;
          console.log('Fetching artwork for:', parsed.artist, '-', parsed.title);
          currentMetadata.artwork = await fetchArtwork(parsed.artist, parsed.title);
          console.log('Broadcasting metadata update');
          broadcast({ type: 'metadata', ...currentMetadata });
        }
      } catch (e) {
        console.error('Metadata parse error:', e.message);
      }
    });

    res.on('error', (err) => {
      console.error('ICY stream error:', err.message);
      // Clean up on error
      icyConnection = null;
    });

    res.on('end', () => {
      console.log('ICY stream ended');
      icyConnection = null;
      // Attempt reconnect after 10 seconds (only if still playing same station)
      setTimeout(() => {
        if (currentStationUrl === streamUrl) {
          connectToStream(streamUrl);
        }
      }, 10000);
    });

    // Consume stream data (required for metadata events)
    res.resume();
  }).on('error', (err) => {
    console.error('ICY connection error:', err.message);
    icyConnection = null;
    // Don't retry immediately on connection error - wait longer
    setTimeout(() => {
      if (currentStationUrl === streamUrl) {
        console.log('Retrying ICY connection...');
        connectToStream(streamUrl);
      }
    }, 15000);
  });
}

// WebSocket handlers
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  // Send current state
  ws.send(JSON.stringify({ type: 'state', metadata: currentMetadata }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('WebSocket message received:', data.type);
      
      if (data.type === 'play' && data.streamUrl) {
        connectToStream(data.streamUrl);
      } else if (data.type === 'stop') {
        if (icyConnection) {
          try {
            icyConnection.destroy();
          } catch (e) {}
          icyConnection = null;
        }
        if (metadataInterval) {
          clearInterval(metadataInterval);
          metadataInterval = null;
        }
        currentStationUrl = null;
        currentMetadata = { artist: '', title: '', artwork: null };
        broadcast({ type: 'metadata', ...currentMetadata });
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    spotify: spotifyTokens?.accessToken ? 'connected' : 'disconnected',
    radio: currentStationUrl ? 'playing' : 'idle'
  });
});

// Radio control API - allows external control of radio playback
app.post('/api/radio/play/:stationId', (req, res) => {
  const { stationId } = req.params;
  console.log(`[Radio] Play station requested: ${stationId}`);
  
  // Broadcast to all WebSocket clients using the radio-command format
  broadcast({ type: 'radio-command', action: 'play', stationId: stationId.toLowerCase() });
  
  res.json({ success: true, message: `Playing station: ${stationId}` });
});

app.post('/api/radio/stop', (req, res) => {
  console.log('[Radio] Stop requested');
  broadcast({ type: 'radio-command', action: 'stop' });
  res.json({ success: true, message: 'Radio stopped' });
});

// Tab control API - allows external control of kiosk tabs
app.post('/api/kiosk/tab/:tabId', (req, res) => {
  const { tabId } = req.params;
  console.log(`[Kiosk] Tab switch requested: ${tabId}`);
  
  // Broadcast to all WebSocket clients
  broadcast({ type: 'switch-tab', tab: tabId.toLowerCase() });
  
  res.json({ success: true, message: `Switching to tab: ${tabId}` });
});

// Weather API
app.get('/api/weather', async (req, res) => {
  if (!config.weather?.apiKey) {
    return res.status(503).json({ error: 'Weather not configured' });
  }

  try {
    const { apiKey, zipCode, country, units } = config.weather;
    const url = `https://api.openweathermap.org/data/2.5/weather?zip=${zipCode},${country}&units=${units}&appid=${apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.cod && data.cod !== 200) {
      console.error('Weather API error:', data.message);
      return res.status(data.cod).json({ error: data.message });
    }
    
    if (!data.main || !data.weather) {
      console.error('Invalid weather API response');
      return res.status(500).json({ error: 'Invalid weather data' });
    }

    res.json({
      temp: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      humidity: data.main.humidity,
      description: data.weather[0].description,
      icon: data.weather[0].icon,
      city: data.name
    });
  } catch (e) {
    console.error('Weather fetch error:', e.message);
    res.status(500).json({ error: 'Failed to fetch weather' });
  }
});

// Forecast: 5 day / 3 hour, condensed to one entry per day plus the next hours.
app.get('/api/weather/forecast', async (req, res) => {
  if (!config.weather?.apiKey) {
    return res.status(503).json({ error: 'Weather not configured' });
  }

  try {
    const { apiKey, zipCode, country, units } = config.weather;
    const url = `https://api.openweathermap.org/data/2.5/forecast?zip=${zipCode},${country}&units=${units}&appid=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.list) {
      return res.status(502).json({ error: data.message || 'Invalid forecast data' });
    }

    const hourly = data.list.slice(0, 8).map((e) => ({
      time: e.dt * 1000,
      temp: Math.round(e.main.temp),
      icon: e.weather?.[0]?.icon,
      description: e.weather?.[0]?.description,
      pop: Math.round((e.pop || 0) * 100),
    }));

    // Group by local calendar day, then reduce each day to a min/max.
    const days = new Map();
    for (const e of data.list) {
      const key = new Date(e.dt * 1000).toDateString();
      const day = days.get(key) || { date: e.dt * 1000, min: Infinity, max: -Infinity, icons: {}, pop: 0 };
      day.min = Math.min(day.min, e.main.temp_min);
      day.max = Math.max(day.max, e.main.temp_max);
      day.pop = Math.max(day.pop, Math.round((e.pop || 0) * 100));
      const ic = e.weather?.[0]?.icon;
      if (ic) day.icons[ic] = (day.icons[ic] || 0) + 1;
      days.set(key, day);
    }

    const daily = [...days.values()].map((d) => ({
      date: d.date,
      min: Math.round(d.min),
      max: Math.round(d.max),
      pop: d.pop,
      // Most frequent icon that day, preferring daytime variants.
      icon: Object.entries(d.icons).sort((a, b) => b[1] - a[1])[0]?.[0] || '01d',
    }));

    res.json({ city: data.city?.name || null, hourly, daily });
  } catch (e) {
    console.error('Forecast fetch error:', e.message);
    res.status(500).json({ error: 'Failed to fetch forecast' });
  }
});

// News API (RSS)
app.get('/api/news', async (req, res) => {
  const rssUrl = config.news?.rssUrl || 'https://feeds.npr.org/1001/rss.xml';
  
  try {
    const response = await fetch(rssUrl);
    const xml = await response.text();
    
    parseString(xml, (err, result) => {
      if (err) {
        console.error('RSS parse error:', err);
        return res.status(500).json({ error: 'Failed to parse news' });
      }
      
      const items = result?.rss?.channel?.[0]?.item || [];

      // Strip tags and collapse whitespace — RSS descriptions carry markup.
      const clean = (s) =>
        String(s || '')
          .replace(/<[^>]*>/g, '')
          .replace(/&(nbsp|amp|quot|#39|lt|gt);/g, (m) =>
            ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }[m] || ' '))
          .replace(/\s+/g, ' ')
          .trim();

      // Feeds place images in several different places; take the first that exists.
      const imageOf = (item) =>
        item['media:content']?.[0]?.$?.url ||
        item['media:thumbnail']?.[0]?.$?.url ||
        (item.enclosure?.[0]?.$?.type?.startsWith('image/') ? item.enclosure[0].$.url : null) ||
        null;

      const headlines = items.slice(0, 24).map((item) => ({
        title: clean(item.title?.[0]),
        link: item.link?.[0] || '',
        description: clean(item.description?.[0]).slice(0, 400),
        pubDate: item.pubDate?.[0] || null,
        author: clean(item['dc:creator']?.[0]) || null,
        image: imageOf(item),
      }));

      res.json({ headlines, source: result?.rss?.channel?.[0]?.title?.[0] || null });
    });
  } catch (e) {
    console.error('News fetch error:', e.message);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// Token persistence file
const tokensFilePath = path.join(__dirname, 'tokens.json');

// Load saved tokens from file
function loadTokens() {
  try {
    if (fs.existsSync(tokensFilePath)) {
      const data = JSON.parse(fs.readFileSync(tokensFilePath, 'utf8'));
      console.log('Loaded saved tokens');
      return data;
    }
  } catch (e) {
    console.error('Error loading tokens:', e.message);
  }
  return { spotify: {}, mixcloud: {} };
}

// Save tokens to file
function saveTokens() {
  try {
    fs.writeFileSync(tokensFilePath, JSON.stringify({
      spotify: spotifyTokens,
      mixcloud: mixcloudTokens
    }, null, 2));
    console.log('Tokens saved');
  } catch (e) {
    console.error('Error saving tokens:', e.message);
  }
}

// Load persisted tokens
const savedTokens = loadTokens();

// Device names the kiosk may appear under in Spotify Connect. The first entry
// must match the `name` the Web Playback SDK registers with in
// frontend/src/contexts/SpotifyPlayerContext.jsx; the rest are earlier names
// kept so an already-paired device is still recognised.
const KIOSK_DEVICE_NAMES = ['Kitchen Kiosk', 'Kitchen Computer'];

// Spotify OAuth & API
let spotifyTokens = savedTokens.spotify || {
  accessToken: null,
  refreshToken: null,
  expiresAt: null
};

// Check if Spotify is authenticated (with auto-refresh)
app.get('/api/spotify/status', async (req, res) => {
  // If token expired but we have a refresh token, try to refresh
  if (spotifyTokens.refreshToken && (!spotifyTokens.accessToken || spotifyTokens.expiresAt <= Date.now())) {
    await refreshSpotifyToken();
  }
  const isAuthenticated = spotifyTokens.accessToken && spotifyTokens.expiresAt > Date.now();
  res.json({ authenticated: isAuthenticated });
});

// Logout / clear Spotify tokens (to re-authenticate with new scopes)
app.post('/api/spotify/logout', (req, res) => {
  spotifyTokens = {
    accessToken: null,
    refreshToken: null,
    expiresAt: null
  };
  saveTokens();
  console.log('Spotify tokens cleared');
  res.json({ success: true });
});

// Start Spotify OAuth flow
app.get('/auth/spotify', (req, res) => {
  if (!config.spotify?.clientId) {
    return res.status(503).json({ error: 'Spotify not configured' });
  }

  const scopes = [
    'user-read-recently-played',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-top-read',
    'user-library-read',
    'user-library-modify',
    'playlist-read-private',
    'streaming',
    'user-read-email',
    'user-read-private'
  ].join(' ');

  const authUrl = `https://accounts.spotify.com/authorize?` +
    `client_id=${config.spotify.clientId}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(config.spotify.redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.redirect(authUrl);
});

// Spotify OAuth callback
app.get('/callback/spotify', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('http://localhost:3001/?spotify_error=' + error);
  }

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          config.spotify.clientId + ':' + config.spotify.clientSecret
        ).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.spotify.redirectUri
      })
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('Spotify token error:', tokens);
      return res.redirect('http://localhost:3001/?spotify_error=' + tokens.error);
    }

    spotifyTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000)
    };
    saveTokens();

    console.log('Spotify authenticated successfully');
    res.redirect('http://localhost:3001/?spotify_success=true');
  } catch (e) {
    console.error('Spotify callback error:', e);
    res.redirect('http://localhost:3001/?spotify_error=callback_failed');
  }
});

// Refresh Spotify token
async function refreshSpotifyToken() {
  if (!spotifyTokens.refreshToken) return false;

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          config.spotify.clientId + ':' + config.spotify.clientSecret
        ).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spotifyTokens.refreshToken
      })
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('Spotify refresh error:', tokens);
      return false;
    }

    spotifyTokens.accessToken = tokens.access_token;
    spotifyTokens.expiresAt = Date.now() + (tokens.expires_in * 1000);
    if (tokens.refresh_token) {
      spotifyTokens.refreshToken = tokens.refresh_token;
    }
    saveTokens();

    return true;
  } catch (e) {
    console.error('Spotify refresh error:', e);
    return false;
  }
}

// Get recently played tracks
app.get('/api/spotify/recently-played', async (req, res) => {
  // Check if token needs refresh
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=20', {
      headers: {
        'Authorization': `Bearer ${spotifyTokens.accessToken}`
      }
    });

    if (response.status === 401) {
      const refreshed = await refreshSpotifyToken();
      if (!refreshed) {
        return res.status(401).json({ error: 'Session expired', needsAuth: true });
      }
      // Retry with new token
      const retryRes = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=20', {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      });
      const data = await retryRes.json();
      return res.json(formatRecentlyPlayed(data));
    }

    const data = await response.json();
    res.json(formatRecentlyPlayed(data));
  } catch (e) {
    console.error('Spotify API error:', e);
    res.status(500).json({ error: 'Failed to fetch recently played' });
  }
});

function formatRecentlyPlayed(data) {
  if (!data.items) return { tracks: [] };
  
  return {
    tracks: data.items.map(item => ({
      id: item.track.id,
      name: item.track.name,
      artist: item.track.artists.map(a => a.name).join(', '),
      artistId: item.track.artists[0]?.id,
      album: item.track.album.name,
      albumId: item.track.album.id,
      albumUri: item.track.album.uri,
      artwork: item.track.album.images[0]?.url,
      playedAt: item.played_at,
      uri: item.track.uri,
      previewUrl: item.track.preview_url,
      externalUrl: item.track.external_urls.spotify
    }))
  };
}

// Get user's playlists
app.get('/api/spotify/playlists', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/playlists?limit=20', {
      headers: {
        'Authorization': `Bearer ${spotifyTokens.accessToken}`
      }
    });

    const data = await response.json();
    
    res.json({
      playlists: data.items?.map(p => ({
        id: p.id,
        name: p.name,
        artwork: p.images[0]?.url,
        tracksCount: p.tracks.total,
        uri: p.uri,
        externalUrl: p.external_urls.spotify
      })) || []
    });
  } catch (e) {
    console.error('Spotify playlists error:', e);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Spotify suggestions (top tracks, artists, featured playlists)
app.get('/api/spotify/suggestions', async (req, res) => {
  // Check if token needs refresh
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    // Fetch top tracks, top artists, and featured playlists in parallel
    const [topTracksRes, topArtistsRes, featuredRes] = await Promise.all([
      fetch('https://api.spotify.com/v1/me/top/tracks?limit=10&time_range=short_term', {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      }),
      fetch('https://api.spotify.com/v1/me/top/artists?limit=10&time_range=short_term', {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      }),
      fetch('https://api.spotify.com/v1/browse/featured-playlists?limit=10', {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      })
    ]);

    const [topTracksData, topArtistsData, featuredData] = await Promise.all([
      topTracksRes.json(),
      topArtistsRes.json(),
      featuredRes.json()
    ]);

    const topTracks = topTracksData.items?.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      artwork: track.album.images[0]?.url,
      uri: track.uri
    })) || [];

    const topArtists = topArtistsData.items?.map(artist => ({
      id: artist.id,
      name: artist.name,
      artwork: artist.images[0]?.url,
      uri: artist.uri,
      genres: artist.genres?.slice(0, 3) || []
    })) || [];

    const featuredPlaylists = featuredData.playlists?.items?.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      artwork: playlist.images[0]?.url,
      uri: playlist.uri,
      tracksCount: playlist.tracks?.total
    })) || [];

    res.json({
      topTracks,
      topArtists,
      featuredPlaylists,
      message: featuredData.message || 'For You'
    });
  } catch (e) {
    console.error('Spotify suggestions error:', e);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Spotify search
app.get('/api/spotify/search', async (req, res) => {
  const { q, type = 'track' } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query required' });
  }

  // Check if token needs refresh
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=20`,
      {
        headers: {
          'Authorization': `Bearer ${spotifyTokens.accessToken}`
        }
      }
    );

    const data = await response.json();

    // Format results based on type (filter out null items that Spotify sometimes returns)
    let results = [];
    if (type === 'track' && data.tracks) {
      results = data.tracks.items.filter(t => t).map(track => ({
        id: track.id,
        name: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        artistId: track.artists[0]?.id,
        album: track.album.name,
        albumId: track.album.id,
        albumUri: track.album.uri,
        artwork: track.album.images[0]?.url,
        uri: track.uri,
        duration: track.duration_ms,
        previewUrl: track.preview_url,
        externalUrl: track.external_urls.spotify
      }));
    } else if (type === 'album' && data.albums) {
      results = data.albums.items.filter(a => a).map(album => ({
        id: album.id,
        name: album.name,
        artist: album.artists.map(a => a.name).join(', '),
        artistId: album.artists[0]?.id,
        artwork: album.images[0]?.url,
        uri: album.uri,
        totalTracks: album.total_tracks,
        externalUrl: album.external_urls.spotify
      }));
    } else if (type === 'artist' && data.artists) {
      results = data.artists.items.filter(a => a).map(artist => ({
        id: artist.id,
        name: artist.name,
        artwork: artist.images[0]?.url,
        uri: artist.uri,
        followers: artist.followers?.total,
        externalUrl: artist.external_urls.spotify
      }));
    } else if (type === 'playlist' && data.playlists) {
      results = data.playlists.items.filter(p => p).map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        owner: playlist.owner?.display_name,
        artwork: playlist.images[0]?.url,
        uri: playlist.uri,
        tracksCount: playlist.tracks?.total,
        externalUrl: playlist.external_urls?.spotify
      }));
    }

    res.json({ results, type });
  } catch (e) {
    console.error('Spotify search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get artist details with top tracks, albums, and related artists
app.get('/api/spotify/artist/:id', async (req, res) => {
  const { id } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const [artistRes, topTracksRes, albumsRes, relatedRes] = await Promise.all([
      fetch(`https://api.spotify.com/v1/artists/${id}`, {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      }),
      fetch(`https://api.spotify.com/v1/artists/${id}/top-tracks?market=US`, {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      }),
      fetch(`https://api.spotify.com/v1/artists/${id}/albums?include_groups=album,single&limit=20&market=US`, {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      }),
      fetch(`https://api.spotify.com/v1/artists/${id}/related-artists`, {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      })
    ]);

    const [artist, topTracksData, albumsData, relatedData] = await Promise.all([
      artistRes.json(),
      topTracksRes.json(),
      albumsRes.json(),
      relatedRes.json()
    ]);

    res.json({
      artist: {
        id: artist.id,
        name: artist.name,
        artwork: artist.images?.[0]?.url,
        followers: artist.followers?.total,
        genres: artist.genres || [],
        popularity: artist.popularity,
        uri: artist.uri
      },
      topTracks: topTracksData.tracks?.map(track => ({
        id: track.id,
        name: track.name,
        artist: track.artists.map(a => a.name).join(', '),
        album: track.album.name,
        albumId: track.album.id,
        artwork: track.album.images?.[0]?.url,
        duration: track.duration_ms,
        uri: track.uri,
        previewUrl: track.preview_url
      })) || [],
      albums: albumsData.items?.map(album => ({
        id: album.id,
        name: album.name,
        artwork: album.images?.[0]?.url,
        releaseDate: album.release_date,
        totalTracks: album.total_tracks,
        albumType: album.album_type,
        uri: album.uri
      })) || [],
      relatedArtists: relatedData.artists?.slice(0, 10).map(a => ({
        id: a.id,
        name: a.name,
        artwork: a.images?.[0]?.url,
        followers: a.followers?.total,
        uri: a.uri
      })) || []
    });
  } catch (e) {
    console.error('Spotify artist error:', e);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

// Get album details with tracks
app.get('/api/spotify/album/:id', async (req, res) => {
  const { id } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.spotify.com/v1/albums/${id}`, {
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    const album = await response.json();

    res.json({
      album: {
        id: album.id,
        name: album.name,
        artist: album.artists?.map(a => a.name).join(', '),
        artistId: album.artists?.[0]?.id,
        artwork: album.images?.[0]?.url,
        releaseDate: album.release_date,
        totalTracks: album.total_tracks,
        label: album.label,
        popularity: album.popularity,
        uri: album.uri,
        copyrights: album.copyrights?.map(c => c.text) || []
      },
      tracks: album.tracks?.items?.map((track, index) => ({
        id: track.id,
        name: track.name,
        trackNumber: track.track_number,
        artist: track.artists?.map(a => a.name).join(', '),
        duration: track.duration_ms,
        uri: track.uri,
        previewUrl: track.preview_url
      })) || []
    });
  } catch (e) {
    console.error('Spotify album error:', e);
    res.status(500).json({ error: 'Failed to fetch album' });
  }
});

// Get user's liked/saved tracks
app.get('/api/spotify/liked', async (req, res) => {
  const { offset = 0, limit = 50 } = req.query;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(
      `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`,
      { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
    );

    const data = await response.json();

    res.json({
      tracks: data.items?.map(item => ({
        id: item.track.id,
        name: item.track.name,
        artist: item.track.artists.map(a => a.name).join(', '),
        artistId: item.track.artists[0]?.id,
        album: item.track.album.name,
        albumId: item.track.album.id,
        artwork: item.track.album.images?.[0]?.url,
        duration: item.track.duration_ms,
        addedAt: item.added_at,
        uri: item.track.uri,
        previewUrl: item.track.preview_url
      })) || [],
      total: data.total,
      hasMore: data.next !== null
    });
  } catch (e) {
    console.error('Spotify liked tracks error:', e);
    res.status(500).json({ error: 'Failed to fetch liked tracks' });
  }
});

// Check if tracks are saved/liked
app.get('/api/spotify/liked/check', async (req, res) => {
  const { ids } = req.query;

  if (!ids) {
    return res.status(400).json({ error: 'Track IDs required' });
  }

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(
      `https://api.spotify.com/v1/me/tracks/contains?ids=${ids}`,
      { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
    );

    const results = await response.json();
    res.json({ results });
  } catch (e) {
    console.error('Spotify check liked error:', e);
    res.status(500).json({ error: 'Failed to check liked status' });
  }
});

// Save/like a track
app.put('/api/spotify/liked/:id', async (req, res) => {
  const { id } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    await fetch(`https://api.spotify.com/v1/me/tracks?ids=${id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Spotify save track error:', e);
    res.status(500).json({ error: 'Failed to save track' });
  }
});

// Remove/unlike a track
app.delete('/api/spotify/liked/:id', async (req, res) => {
  const { id } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    await fetch(`https://api.spotify.com/v1/me/tracks?ids=${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Spotify remove track error:', e);
    res.status(500).json({ error: 'Failed to remove track' });
  }
});

// Get browse categories
app.get('/api/spotify/categories', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(
      'https://api.spotify.com/v1/browse/categories?limit=40&locale=en_US',
      { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
    );

    const data = await response.json();

    res.json({
      categories: data.categories?.items?.map(cat => ({
        id: cat.id,
        name: cat.name,
        artwork: cat.icons?.[0]?.url
      })) || []
    });
  } catch (e) {
    console.error('Spotify categories error:', e);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get playlists for a category
app.get('/api/spotify/category/:id/playlists', async (req, res) => {
  const { id } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(
      `https://api.spotify.com/v1/browse/categories/${id}/playlists?limit=30`,
      { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
    );

    const data = await response.json();

    res.json({
      playlists: data.playlists?.items?.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        artwork: p.images?.[0]?.url,
        owner: p.owner?.display_name,
        tracksCount: p.tracks?.total,
        uri: p.uri
      })) || []
    });
  } catch (e) {
    console.error('Spotify category playlists error:', e);
    res.status(500).json({ error: 'Failed to fetch category playlists' });
  }
});

// Get new releases
app.get('/api/spotify/new-releases', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(
      'https://api.spotify.com/v1/browse/new-releases?limit=30',
      { headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` } }
    );

    const data = await response.json();

    res.json({
      albums: data.albums?.items?.map(album => ({
        id: album.id,
        name: album.name,
        artist: album.artists?.map(a => a.name).join(', '),
        artistId: album.artists?.[0]?.id,
        artwork: album.images?.[0]?.url,
        releaseDate: album.release_date,
        totalTracks: album.total_tracks,
        uri: album.uri
      })) || []
    });
  } catch (e) {
    console.error('Spotify new releases error:', e);
    res.status(500).json({ error: 'Failed to fetch new releases' });
  }
});

// Get playlist tracks
app.get('/api/spotify/playlist/:id/tracks', async (req, res) => {
  const { id } = req.params;
  const { offset = 0, limit = 50 } = req.query;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const [playlistRes, tracksRes] = await Promise.all([
      fetch(`https://api.spotify.com/v1/playlists/${id}?fields=id,name,description,images,owner,followers`, {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      }),
      fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?limit=${limit}&offset=${offset}`, {
        headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
      })
    ]);

    const [playlist, tracksData] = await Promise.all([
      playlistRes.json(),
      tracksRes.json()
    ]);

    res.json({
      playlist: {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        artwork: playlist.images?.[0]?.url,
        owner: playlist.owner?.display_name,
        followers: playlist.followers?.total
      },
      tracks: tracksData.items?.filter(item => item.track).map(item => ({
        id: item.track.id,
        name: item.track.name,
        artist: item.track.artists?.map(a => a.name).join(', '),
        artistId: item.track.artists?.[0]?.id,
        album: item.track.album?.name,
        albumId: item.track.album?.id,
        artwork: item.track.album?.images?.[0]?.url,
        duration: item.track.duration_ms,
        addedAt: item.added_at,
        uri: item.track.uri
      })) || [],
      total: tracksData.total,
      hasMore: tracksData.next !== null
    });
  } catch (e) {
    console.error('Spotify playlist tracks error:', e);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});

// Get access token for Web Playback SDK
app.get('/api/spotify/token', (req, res) => {
  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  res.json({
    accessToken: spotifyTokens.accessToken,
    expiresAt: spotifyTokens.expiresAt
  });
});

// Get current playback state
app.get('/api/spotify/playback', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    if (response.status === 204) {
      return res.json({ isPlaying: false, device: null, track: null });
    }

    const data = await response.json();

    res.json({
      isPlaying: data.is_playing,
      progress: data.progress_ms,
      device: data.device ? {
        id: data.device.id,
        name: data.device.name,
        type: data.device.type,
        volume: data.device.volume_percent
      } : null,
      track: data.item ? {
        id: data.item.id,
        name: data.item.name,
        artist: data.item.artists?.map(a => a.name).join(', '),
        album: data.item.album?.name,
        artwork: data.item.album?.images?.[0]?.url,
        duration: data.item.duration_ms,
        uri: data.item.uri
      } : null,
      shuffle: data.shuffle_state,
      repeat: data.repeat_state
    });
  } catch (e) {
    console.error('Spotify playback state error:', e);
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

// Get available devices
app.get('/api/spotify/devices', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    const data = await response.json();

    res.json({
      devices: data.devices?.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type,
        isActive: d.is_active,
        volume: d.volume_percent
      })) || []
    });
  } catch (e) {
    console.error('Spotify devices error:', e);
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

// Start/resume playback
app.put('/api/spotify/play', async (req, res) => {
  const { uri, uris, context_uri, device_id, position_ms, offset } = req.body;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  // Pick a device to play on. Prefers the in-app Web Playback SDK player, then
  // whatever is already active, then anything at all. The SDK registers itself
  // under the first KIOSK_DEVICE_NAMES entry; matching a single hardcoded name
  // that no device used left the request with no device_id, which Spotify
  // rejects with NO_ACTIVE_DEVICE, so nothing played.
  const findTargetDevice = async () => {
    const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });
    if (!devRes.ok) return null;
    const { devices } = await devRes.json();
    if (!devices?.length) return null;
    return devices.find(d => KIOSK_DEVICE_NAMES.includes(d.name))
      || devices.find(d => d.is_active)
      || devices[0];
  };

  // Helper to transfer playback
  const transferToDevice = async (targetDeviceId) => {
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${spotifyTokens.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ device_ids: [targetDeviceId], play: false })
    });
    // Brief delay for transfer to complete
    await new Promise(r => setTimeout(r, 300));
  };

  try {
    let targetDeviceId = device_id;

    // If no device specified, resolve one and hand playback to it if needed
    if (!targetDeviceId) {
      const target = await findTargetDevice();
      if (target) {
        if (!target.is_active) {
          console.log(`[Spotify] No active device, transferring to "${target.name}"...`);
          await transferToDevice(target.id);
        }
        targetDeviceId = target.id;
      } else {
        console.warn('[Spotify] No available Spotify devices to play on');
        return res.status(404).json({
          error: 'No available Spotify device. Open Spotify on this device, or check that the in-app player started (it needs Spotify Premium).',
          noDevice: true
        });
      }
    }

    const queryParams = targetDeviceId ? `?device_id=${targetDeviceId}` : '';
    const body = {};

    if (uris) body.uris = uris;
    else if (uri) body.uris = [uri];
    if (context_uri) body.context_uri = context_uri;
    if (offset) body.offset = offset;
    if (position_ms) body.position_ms = position_ms;

    const response = await fetch(`https://api.spotify.com/v1/me/player/play${queryParams}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${spotifyTokens.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
    });

    if (response.status === 204 || response.status === 200) {
      res.json({ success: true });
    } else {
      const error = await response.json();
      res.status(response.status).json({ error: error.error?.message || 'Playback failed' });
    }
  } catch (e) {
    console.error('Spotify play error:', e);
    res.status(500).json({ error: 'Failed to start playback' });
  }
});

// Pause playback
app.put('/api/spotify/pause', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify pause error:', e);
    res.status(500).json({ error: 'Failed to pause' });
  }
});

// Skip to next track
app.post('/api/spotify/next', async (req, res) => {
  console.log('[Spotify] NEXT track requested');
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });
    console.log('[Spotify] NEXT response:', response.status);
    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify next error:', e);
    res.status(500).json({ error: 'Failed to skip' });
  }
});

// Skip to previous track
app.post('/api/spotify/prev', async (req, res) => {
  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/previous', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify previous error:', e);
    res.status(500).json({ error: 'Failed to go back' });
  }
});

// Set volume
app.put('/api/spotify/volume/:percent', async (req, res) => {
  const { percent } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${percent}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify volume error:', e);
    res.status(500).json({ error: 'Failed to set volume' });
  }
});

// Transfer playback to a device
app.put('/api/spotify/transfer', async (req, res) => {
  const { device_id, play = false } = req.body;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${spotifyTokens.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ device_ids: [device_id], play })
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify transfer error:', e);
    res.status(500).json({ error: 'Failed to transfer playback' });
  }
});

// Toggle shuffle
app.put('/api/spotify/shuffle/:state', async (req, res) => {
  const { state } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=${state}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify shuffle error:', e);
    res.status(500).json({ error: 'Failed to toggle shuffle' });
  }
});

// Set repeat mode
app.put('/api/spotify/repeat/:state', async (req, res) => {
  const { state } = req.params; // track, context, or off

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/repeat?state=${state}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify repeat error:', e);
    res.status(500).json({ error: 'Failed to set repeat mode' });
  }
});

// Seek to position in track
app.put('/api/spotify/seek/:position_ms', async (req, res) => {
  const { position_ms } = req.params;

  if (spotifyTokens.expiresAt && spotifyTokens.expiresAt < Date.now() + 60000) {
    await refreshSpotifyToken();
  }

  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${position_ms}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });

    res.json({ success: response.status === 204 || response.status === 200 });
  } catch (e) {
    console.error('Spotify seek error:', e);
    res.status(500).json({ error: 'Failed to seek' });
  }
});

// Mixcloud OAuth & API
let mixcloudTokens = savedTokens.mixcloud || {
  accessToken: null
};

// Check if Mixcloud is authenticated
app.get('/api/mixcloud/status', (req, res) => {
  const isAuthenticated = !!mixcloudTokens.accessToken;
  res.json({ authenticated: isAuthenticated });
});

// Start Mixcloud OAuth flow
app.get('/auth/mixcloud', (req, res) => {
  if (!config.mixcloud?.clientId) {
    return res.status(503).json({ error: 'Mixcloud not configured' });
  }

  const authUrl = `https://www.mixcloud.com/oauth/authorize?` +
    `client_id=${config.mixcloud.clientId}` +
    `&redirect_uri=${encodeURIComponent(config.mixcloud.redirectUri)}`;

  res.redirect(authUrl);
});

// Mixcloud OAuth callback
app.get('/callback/mixcloud', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('http://localhost:3001/?mixcloud_error=' + error);
  }

  try {
    const tokenUrl = `https://www.mixcloud.com/oauth/access_token?` +
      `client_id=${config.mixcloud.clientId}` +
      `&redirect_uri=${encodeURIComponent(config.mixcloud.redirectUri)}` +
      `&client_secret=${config.mixcloud.clientSecret}` +
      `&code=${code}`;

    const tokenRes = await fetch(tokenUrl, { method: 'POST' });
    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('Mixcloud token error:', tokens);
      return res.redirect('http://localhost:3001/?mixcloud_error=' + tokens.error);
    }

    mixcloudTokens = {
      accessToken: tokens.access_token
    };
    saveTokens();

    console.log('Mixcloud authenticated successfully');
    res.redirect('http://localhost:3001/?mixcloud_success=true');
  } catch (e) {
    console.error('Mixcloud callback error:', e);
    res.redirect('http://localhost:3001/?mixcloud_error=callback_failed');
  }
});

// Get current user info
app.get('/api/mixcloud/me', async (req, res) => {
  if (!mixcloudTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.mixcloud.com/me/?access_token=${mixcloudTokens.accessToken}`);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error('Mixcloud me error:', e);
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

// Get user's listening history
app.get('/api/mixcloud/history', async (req, res) => {
  if (!mixcloudTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.mixcloud.com/me/listens/?access_token=${mixcloudTokens.accessToken}&limit=20`);
    const data = await response.json();
    
    res.json({
      shows: data.data?.map(item => ({
        key: item.key,
        name: item.name,
        artist: item.user?.name,
        artwork: item.pictures?.extra_large || item.pictures?.large,
        url: item.url,
        duration: item.audio_length,
        tags: item.tags?.slice(0, 3).map(t => t.name) || []
      })) || []
    });
  } catch (e) {
    console.error('Mixcloud history error:', e);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get user's favorites
app.get('/api/mixcloud/favorites', async (req, res) => {
  if (!mixcloudTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.mixcloud.com/me/favorites/?access_token=${mixcloudTokens.accessToken}&limit=20`);
    const data = await response.json();
    
    res.json({
      shows: data.data?.map(item => ({
        key: item.key,
        name: item.name,
        artist: item.user?.name,
        artwork: item.pictures?.extra_large || item.pictures?.large,
        url: item.url,
        duration: item.audio_length,
        tags: item.tags?.slice(0, 3).map(t => t.name) || []
      })) || []
    });
  } catch (e) {
    console.error('Mixcloud favorites error:', e);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// Mixcloud search (public API - no auth required)
app.get('/api/mixcloud/search', async (req, res) => {
  const { q, type = 'cloudcast' } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Query required' });
  }

  try {
    const response = await fetch(
      `https://api.mixcloud.com/search/?q=${encodeURIComponent(q)}&type=${type}&limit=20`
    );

    const data = await response.json();

    const results = data.data?.map(item => ({
      key: item.key,
      name: item.name,
      artist: item.user?.name,
      artwork: item.pictures?.extra_large || item.pictures?.large || item.pictures?.medium,
      url: item.url,
      duration: item.audio_length,
      tags: item.tags?.slice(0, 3).map(t => t.name) || [],
      playCount: item.play_count,
      favoriteCount: item.favorite_count
    })) || [];

    res.json({ results, type });
  } catch (e) {
    console.error('Mixcloud search error:', e);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get user's playlists
app.get('/api/mixcloud/playlists', async (req, res) => {
  if (!mixcloudTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    const response = await fetch(`https://api.mixcloud.com/me/playlists/?access_token=${mixcloudTokens.accessToken}&limit=20`);
    const data = await response.json();

    res.json({
      playlists: data.data?.map(item => ({
        key: item.key,
        name: item.name,
        slug: item.slug,
        showCount: item.cloudcast_count,
        url: item.url
      })) || []
    });
  } catch (e) {
    console.error('Mixcloud playlists error:', e);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get shows from a specific playlist
app.get('/api/mixcloud/playlist/:user/:slug', async (req, res) => {
  const { user, slug } = req.params;

  try {
    const response = await fetch(`https://api.mixcloud.com/${user}/playlists/${slug}/cloudcasts/?limit=50`);
    const data = await response.json();

    res.json({
      shows: data.data?.map(item => ({
        key: item.key,
        name: item.name,
        artist: item.user?.name,
        artwork: item.pictures?.extra_large || item.pictures?.large,
        url: item.url,
        duration: item.audio_length,
        tags: item.tags?.slice(0, 3).map(t => t.name) || []
      })) || []
    });
  } catch (e) {
    console.error('Mixcloud playlist shows error:', e);
    res.status(500).json({ error: 'Failed to fetch playlist shows' });
  }
});

// Get new uploads from DJs you follow (user's feed)
app.get('/api/mixcloud/feed', async (req, res) => {
  if (!mixcloudTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    // First get the user's username
    const meRes = await fetch(`https://api.mixcloud.com/me/?access_token=${mixcloudTokens.accessToken}`);
    const meData = await meRes.json();

    if (!meData.username) {
      console.error('[Mixcloud] Could not get username');
      return res.status(500).json({ error: 'Could not get user info' });
    }

    console.log(`[Mixcloud] Fetching feed for user: ${meData.username}`);

    // Use the user's feed endpoint - this shows uploads from people they follow
    const feedRes = await fetch(`https://api.mixcloud.com/${meData.username}/feed/?access_token=${mixcloudTokens.accessToken}&limit=30`);
    const feedData = await feedRes.json();

    console.log('[Mixcloud] Feed response:', JSON.stringify(feedData, null, 2).substring(0, 1000));

    let shows = [];

    if (feedData.data && feedData.data.length > 0) {
      shows = feedData.data
        .filter(item => item.key && item.name) // Filter to cloudcasts only
        .map(item => ({
          key: item.key,
          name: item.name,
          artist: item.user?.name,
          artwork: item.pictures?.extra_large || item.pictures?.large || item.pictures?.medium,
          url: item.url,
          duration: item.audio_length,
          tags: item.tags?.slice(0, 3).map(t => t.name) || [],
          createdTime: item.created_time
        }));
    }

    // If feed is empty, fall back to getting uploads from followed users
    if (shows.length === 0) {
      console.log('[Mixcloud] Feed empty, fetching from followed users...');

      const followingRes = await fetch(`https://api.mixcloud.com/me/following/?access_token=${mixcloudTokens.accessToken}&limit=15`);
      const followingData = await followingRes.json();

      console.log(`[Mixcloud] Following ${followingData.data?.length || 0} users`);

      if (followingData.data && followingData.data.length > 0) {
        for (const user of followingData.data.slice(0, 10)) {
          try {
            const userKey = user.key || `/${user.username}/`;
            const uploadsRes = await fetch(`https://api.mixcloud.com${userKey}cloudcasts/?limit=5`);
            const uploadsData = await uploadsRes.json();

            if (uploadsData.data) {
              for (const cloudcast of uploadsData.data) {
                shows.push({
                  key: cloudcast.key,
                  name: cloudcast.name,
                  artist: cloudcast.user?.name || user.name,
                  artwork: cloudcast.pictures?.extra_large || cloudcast.pictures?.large || cloudcast.pictures?.medium,
                  url: cloudcast.url,
                  duration: cloudcast.audio_length,
                  tags: cloudcast.tags?.slice(0, 3).map(t => t.name) || [],
                  createdTime: cloudcast.created_time
                });
              }
            }
          } catch (e) {
            console.error(`[Mixcloud] Error fetching uploads:`, e.message);
          }
        }

        // Sort by created time (newest first)
        shows.sort((a, b) => {
          if (!a.createdTime || !b.createdTime) return 0;
          return new Date(b.createdTime) - new Date(a.createdTime);
        });
      }
    }

    console.log(`[Mixcloud] Found ${shows.length} shows`);
    res.json({ shows: shows.slice(0, 30) });
  } catch (e) {
    console.error('Mixcloud feed error:', e);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// Get latest uploads from artists you've favorited
app.get('/api/mixcloud/favorites-updates', async (req, res) => {
  if (!mixcloudTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated', needsAuth: true });
  }

  try {
    // Get user's favorites to find unique artists
    const favRes = await fetch(`https://api.mixcloud.com/me/favorites/?access_token=${mixcloudTokens.accessToken}&limit=100`);
    const favData = await favRes.json();

    if (!favData.data || favData.data.length === 0) {
      return res.json({ shows: [] });
    }

    // Extract unique artists from favorites
    const artistKeys = new Map();
    for (const fav of favData.data) {
      if (fav.user?.key && !artistKeys.has(fav.user.key)) {
        artistKeys.set(fav.user.key, fav.user.name);
      }
    }

    console.log(`[Mixcloud] Found ${artistKeys.size} unique artists from favorites`);

    // Fetch latest uploads from each artist (limit to 15 artists to avoid too many requests)
    const shows = [];
    const artistList = Array.from(artistKeys.entries()).slice(0, 15);

    for (const [artistKey, artistName] of artistList) {
      try {
        const uploadsRes = await fetch(`https://api.mixcloud.com${artistKey}cloudcasts/?limit=3`);
        const uploadsData = await uploadsRes.json();

        if (uploadsData.data) {
          for (const cloudcast of uploadsData.data) {
            shows.push({
              key: cloudcast.key,
              name: cloudcast.name,
              artist: cloudcast.user?.name || artistName,
              artwork: cloudcast.pictures?.extra_large || cloudcast.pictures?.large || cloudcast.pictures?.medium,
              url: cloudcast.url,
              duration: cloudcast.audio_length,
              tags: cloudcast.tags?.slice(0, 3).map(t => t.name) || [],
              createdTime: cloudcast.created_time
            });
          }
        }
      } catch (e) {
        console.error(`[Mixcloud] Error fetching uploads for ${artistKey}:`, e.message);
      }
    }

    // Sort by created time (newest first)
    shows.sort((a, b) => {
      if (!a.createdTime || !b.createdTime) return 0;
      return new Date(b.createdTime) - new Date(a.createdTime);
    });

    console.log(`[Mixcloud] Found ${shows.length} shows from favorited artists`);
    res.json({ shows: shows.slice(0, 30) });
  } catch (e) {
    console.error('Mixcloud favorites-updates error:', e);
    res.status(500).json({ error: 'Failed to fetch favorites updates' });
  }
});

// ============================================
// TWITCH
// ============================================
//
// A Twitch channel is video, so it plays in the frontend's embed rather than
// through the <audio> element the radio stations use. What the backend adds is
// the part the embed cannot answer: which of the listener's channels are
// actually live right now, and what they are streaming.
//
// Helix needs an app access token, which needs a client id and secret. Without
// them every channel still plays — the kiosk simply does not claim to know
// whether one is on air, rather than guessing or showing a stale badge.

// Channel subscriptions live in their own file. config.json holds real secrets
// and a branch checkout that untracks it deletes it, so the server never
// rewrites that file; this one it owns and may recreate empty.
const twitchChannelsPath = path.join(__dirname, 'twitch-channels.json');

// Twitch logins: 4-25 characters, alphanumerics and underscore, not starting
// with an underscore. Validated because the value reaches a request URL.
const TWITCH_LOGIN = /^[a-zA-Z0-9][a-zA-Z0-9_]{3,24}$/;

function loadTwitchChannels() {
  try {
    if (fs.existsSync(twitchChannelsPath)) {
      const data = JSON.parse(fs.readFileSync(twitchChannelsPath, 'utf8'));
      if (Array.isArray(data?.channels)) {
        return data.channels.filter((login) => TWITCH_LOGIN.test(login));
      }
    }
  } catch (e) {
    console.error('[Twitch] Could not read channel list:', e.message);
  }
  return [];
}

function saveTwitchChannels(channels) {
  try {
    fs.writeFileSync(twitchChannelsPath, JSON.stringify({ channels }, null, 2));
    return true;
  } catch (e) {
    console.error('[Twitch] Could not save channel list:', e.message);
    return false;
  }
}

let twitchChannels = loadTwitchChannels();
let twitchAppToken = { value: null, expiresAt: 0 };
// Helix answers are cached briefly: the frontend polls this while the Twitch
// stave is open, and a live/offline state does not change second to second.
let twitchCache = { at: 0, payload: null };
const TWITCH_CACHE_MS = 30_000;

const twitchConfigured = () =>
  Boolean(config.twitch?.clientId && config.twitch?.clientSecret);

/** An app access token, fetched on demand and reused until it expires. */
async function getTwitchToken() {
  if (!twitchConfigured()) return null;
  if (twitchAppToken.value && Date.now() < twitchAppToken.expiresAt) {
    return twitchAppToken.value;
  }

  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    grant_type: 'client_credentials',
  });

  try {
    const response = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, {
      method: 'POST',
    });
    if (!response.ok) {
      console.error('[Twitch] Token request failed:', response.status);
      return null;
    }
    const data = await response.json();
    if (!data.access_token) return null;
    twitchAppToken = {
      value: data.access_token,
      // A minute of headroom, so a token never expires mid-request.
      expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
    };
    return twitchAppToken.value;
  } catch (e) {
    console.error('[Twitch] Token request error:', e.message);
    return null;
  }
}

async function helix(endpoint, logins, token) {
  // Helix takes up to 100 logins per request; the kiosk will never have that
  // many, but the query is built the same way regardless.
  const params = new URLSearchParams();
  const key = endpoint === 'streams' ? 'user_login' : 'login';
  for (const login of logins.slice(0, 100)) params.append(key, login);

  const response = await fetch(`https://api.twitch.tv/helix/${endpoint}?${params}`, {
    headers: {
      'Client-Id': config.twitch.clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`helix/${endpoint} responded ${response.status}`);
  }
  const data = await response.json();
  return data.data ?? [];
}

/**
 * The subscribed channels, enriched with live state where that is knowable.
 * `live` is deliberately null rather than false when it is not: "we cannot
 * tell" and "it is off air" are different things, and the card says which.
 */
async function describeTwitchChannels() {
  const channels = twitchChannels;
  const configured = twitchConfigured();

  if (channels.length === 0) {
    return { configured, channels: [], stale: false };
  }

  if (!configured) {
    return {
      configured: false,
      channels: channels.map((login) => ({
        login,
        displayName: login,
        live: null,
        title: null,
        game: null,
        viewers: null,
        thumbnail: null,
        profileImage: null,
      })),
      stale: false,
    };
  }

  if (twitchCache.payload && Date.now() - twitchCache.at < TWITCH_CACHE_MS) {
    const known = new Set(twitchCache.payload.channels.map((c) => c.login));
    // The cache is only good while it covers exactly the current list.
    if (known.size === channels.length && channels.every((login) => known.has(login))) {
      return twitchCache.payload;
    }
  }

  const token = await getTwitchToken();
  if (!token) {
    return {
      configured: true,
      channels: channels.map((login) => ({
        login,
        displayName: login,
        live: null,
        title: null,
        game: null,
        viewers: null,
        thumbnail: null,
        profileImage: null,
      })),
      stale: true,
      error: 'Twitch would not issue a token. Check the client id and secret.',
    };
  }

  try {
    const [users, streams] = await Promise.all([
      helix('users', channels, token),
      helix('streams', channels, token),
    ]);

    const userByLogin = new Map(users.map((u) => [u.login.toLowerCase(), u]));
    const streamByLogin = new Map(streams.map((s) => [s.user_login.toLowerCase(), s]));

    const payload = {
      configured: true,
      stale: false,
      channels: channels.map((login) => {
        const key = login.toLowerCase();
        const user = userByLogin.get(key);
        const stream = streamByLogin.get(key);
        return {
          login,
          displayName: user?.display_name ?? login,
          // A login Twitch does not know at all is not "offline"; it is absent.
          exists: Boolean(user),
          live: user ? Boolean(stream) : null,
          title: stream?.title ?? null,
          game: stream?.game_name ?? null,
          viewers: stream?.viewer_count ?? null,
          startedAt: stream?.started_at ?? null,
          thumbnail: stream?.thumbnail_url
            ? stream.thumbnail_url.replace('{width}', '320').replace('{height}', '180')
            : null,
          profileImage: user?.profile_image_url ?? null,
        };
      }),
    };

    twitchCache = { at: Date.now(), payload };
    return payload;
  } catch (e) {
    console.error('[Twitch] Helix request failed:', e.message);
    return {
      configured: true,
      stale: true,
      error: 'Could not reach Twitch. Live state is unknown.',
      channels: channels.map((login) => ({
        login,
        displayName: login,
        live: null,
        title: null,
        game: null,
        viewers: null,
        thumbnail: null,
        profileImage: null,
      })),
    };
  }
}

app.get('/api/twitch/status', async (req, res) => {
  try {
    res.json(await describeTwitchChannels());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/twitch/channels', async (req, res) => {
  const raw = String(req.body?.login ?? '').trim().replace(/^@/, '');
  // Accept a pasted channel URL as well as a bare login — on a touchscreen
  // the URL is what gets typed.
  const login = raw.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#]/)[0];

  if (!TWITCH_LOGIN.test(login)) {
    return res.status(400).json({ error: 'That is not a Twitch channel name.' });
  }
  if (twitchChannels.some((existing) => existing.toLowerCase() === login.toLowerCase())) {
    return res.status(409).json({ error: `${login} is already on the list.` });
  }

  // Where credentials exist, refuse a channel Twitch has never heard of
  // rather than adding a tile that can only ever fail to play.
  if (twitchConfigured()) {
    const token = await getTwitchToken();
    if (token) {
      try {
        const users = await helix('users', [login], token);
        if (users.length === 0) {
          return res.status(404).json({ error: `Twitch has no channel called ${login}.` });
        }
      } catch (e) {
        // Twitch unreachable: adding it is still the listener's call.
        console.error('[Twitch] Could not verify channel:', e.message);
      }
    }
  }

  twitchChannels = [...twitchChannels, login];
  twitchCache = { at: 0, payload: null };
  if (!saveTwitchChannels(twitchChannels)) {
    return res.status(500).json({ error: 'Added for this session, but could not be saved.' });
  }
  console.log(`[Twitch] Added channel: ${login}`);
  res.json(await describeTwitchChannels());
});

app.delete('/api/twitch/channels/:login', async (req, res) => {
  const login = String(req.params.login ?? '');
  const before = twitchChannels.length;
  twitchChannels = twitchChannels.filter(
    (existing) => existing.toLowerCase() !== login.toLowerCase(),
  );
  if (twitchChannels.length === before) {
    return res.status(404).json({ error: `${login} is not on the list.` });
  }
  twitchCache = { at: 0, payload: null };
  saveTwitchChannels(twitchChannels);
  console.log(`[Twitch] Removed channel: ${login}`);
  res.json(await describeTwitchChannels());
});

// ============================================
// KIOSK MODE - App Launcher Endpoints
// ============================================

// Configuration for external apps
const kioskApps = {
  spotify: {
    name: 'Spotify',
    // Try multiple commands in order of preference
    commands: [
      'spotify',                          // Native Linux app
      'flatpak run com.spotify.Client',   // Flatpak install
      'snap run spotify',                 // Snap install
    ],
    // URL scheme for mobile/alternative launch
    urlScheme: 'spotify://',
    webUrl: 'https://open.spotify.com',
  },
  mixcloud: {
    name: 'Mixcloud',
    // Mixcloud doesn't have a native Linux app, so we open in browser
    commands: [
      'xdg-open https://www.mixcloud.com',
    ],
    urlScheme: 'mixcloud://',
    webUrl: 'https://www.mixcloud.com',
  },
  // Add more apps as needed
  firefox: {
    name: 'Firefox',
    commands: ['firefox'],
  },
  chromium: {
    name: 'Chromium',
    commands: ['chromium-browser', 'chromium'],
  }
};

// Track launched app processes
let launchedApps = {};

// Helper to check if a command exists
function commandExists(cmd) {
  return new Promise((resolve) => {
    exec(`which ${cmd.split(' ')[0]}`, (error) => {
      resolve(!error);
    });
  });
}

// Launch an external app
app.post('/api/kiosk/launch/:appId', async (req, res) => {
  const { appId } = req.params;
  const appConfig = kioskApps[appId];
  
  if (!appConfig) {
    return res.status(404).json({ 
      success: false, 
      error: `Unknown app: ${appId}`,
      availableApps: Object.keys(kioskApps)
    });
  }

  console.log(`[Kiosk] Attempting to launch ${appConfig.name}...`);

  // Try each command until one works
  for (const cmd of appConfig.commands) {
    const baseCmd = cmd.split(' ')[0];
    const exists = await commandExists(baseCmd);
    
    if (exists) {
      try {
        console.log(`[Kiosk] Launching: ${cmd}`);
        
        // Spawn the process detached so it survives if the server restarts
        const child = spawn(cmd, [], {
          shell: true,
          detached: true,
          stdio: 'ignore'
        });
        
        child.unref();
        
        // Track it
        launchedApps[appId] = {
          pid: child.pid,
          launchedAt: new Date().toISOString(),
          command: cmd
        };
        
        // Style the window after a delay (remove title bar, resize)
        // Note: Spotify is handled by devilspie2, skip backend styling
        setTimeout(async () => {
          if (appId !== 'spotify') {
            await styleAppWindow(appConfig.name);
          }
        }, 2000);
        
        return res.json({ 
          success: true, 
          app: appConfig.name,
          method: 'native',
          command: cmd,
          pid: child.pid
        });
      } catch (e) {
        console.error(`[Kiosk] Failed to launch ${cmd}:`, e.message);
      }
    }
  }

  // No native app found, launch web URL in a separate browser window
  if (appConfig.webUrl) {
    console.log(`[Kiosk] No native app found for ${appId}, opening web version in new window`);

    try {
      // Launch Firefox in a regular (non-kiosk) window so it can be closed
      const child = spawn('firefox', ['--new-window', appConfig.webUrl], {
        detached: true,
        stdio: 'ignore'
      });

      child.unref();

      // Track it
      launchedApps[appId] = {
        pid: child.pid,
        launchedAt: new Date().toISOString(),
        command: `firefox --new-window ${appConfig.webUrl}`,
        method: 'web'
      };

      // Maximize the window after a delay
      setTimeout(async () => {
        await styleAppWindow('Mozilla Firefox');
      }, 2000);

      return res.json({
        success: true,
        app: appConfig.name,
        method: 'web',
        webUrl: appConfig.webUrl,
        pid: child.pid,
        message: 'Opened in new browser window - close window to return'
      });
    } catch (e) {
      console.error(`[Kiosk] Failed to open web URL:`, e.message);
    }
  }

  // Complete fallback - no native app and couldn't open web
  console.log(`[Kiosk] No native app or web URL for ${appId}`);
  res.json({
    success: false,
    app: appConfig.name,
    error: 'No launch method available'
  });
});

// Style app window - remove decorations and resize for kiosk look
async function styleAppWindow(appName) {
  const wmctrlExists = await commandExists('wmctrl');
  const xdotoolExists = await commandExists('xdotool');

  if (wmctrlExists) {
    // Remove window decorations (title bar) and maximize
    exec(`wmctrl -r "${appName}" -b add,maximized_vert,maximized_horz`, (err) => {
      if (err) console.log(`[Kiosk] Could not maximize ${appName}`);
    });

    // Remove decorations (frameless)
    exec(`wmctrl -r "${appName}" -b add,fullscreen`, (err) => {
      if (!err) {
        console.log(`[Kiosk] Made ${appName} fullscreen`);
      } else {
        // Try undecorate as fallback
        exec(`wmctrl -r "${appName}" -b remove,decorated`, (err2) => {
          if (err2) console.log(`[Kiosk] Could not undecorate ${appName}`);
        });
      }
    });
  } else if (xdotoolExists) {
    // Use xdotool to find and resize window
    exec(`xdotool search --name "${appName}" | head -1`, (err, stdout) => {
      if (!err && stdout.trim()) {
        const windowId = stdout.trim();
        // Make fullscreen
        exec(`xdotool key --window ${windowId} F11`, (err) => {
          if (!err) console.log(`[Kiosk] Toggled fullscreen for ${appName}`);
        });
      }
    });
  }
}

// Style Spotify window as borderless 90% overlay
async function styleSpotifyWindow() {
  const wmctrlExists = await commandExists('wmctrl');
  const xdotoolExists = await commandExists('xdotool');

  if (!wmctrlExists) {
    console.log('[Kiosk] wmctrl not available, cannot style Spotify window');
    return;
  }

  // Get screen dimensions using xdpyinfo
  exec('xdpyinfo | grep dimensions', (err, stdout) => {
    if (err) {
      console.log('[Kiosk] Could not get screen dimensions');
      return;
    }

    // Parse dimensions like "dimensions:    2736x1824 pixels"
    const match = stdout.match(/(\d+)x(\d+)/);
    if (!match) {
      console.log('[Kiosk] Could not parse screen dimensions');
      return;
    }

    const screenWidth = parseInt(match[1], 10);
    const screenHeight = parseInt(match[2], 10);

    // Calculate size: 85% width (leaving 15% on left for back button), 92% height
    const windowWidth = Math.floor(screenWidth * 0.85);
    const windowHeight = Math.floor(screenHeight * 0.92);
    // Position: 14% from left (leaves visible column for button), 4% from top
    const x = Math.floor(screenWidth * 0.14);
    const y = Math.floor(screenHeight * 0.04);

    console.log(`[Kiosk] Screen: ${screenWidth}x${screenHeight}, Spotify window: ${windowWidth}x${windowHeight} at (${x},${y})`);

    // Step 1: Remove maximized/fullscreen state
    exec('wmctrl -r "Spotify" -b remove,maximized_vert,maximized_horz,fullscreen', () => {
      // Step 2: Remove window decorations (title bar/borders) using wmctrl
      exec('wmctrl -r "Spotify" -b remove,decorated', (err) => {
        if (err) {
          console.log('[Kiosk] wmctrl remove,decorated failed, trying xprop...');
          // Fallback: Use xprop to remove decorations (works on more WMs)
          if (xdotoolExists) {
            exec('xdotool search --name "Spotify" | head -1', (err, windowId) => {
              if (!err && windowId.trim()) {
                // Set Motif hints to remove decorations
                exec(`xprop -id ${windowId.trim()} -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "0x2, 0x0, 0x0, 0x0, 0x0"`, (err) => {
                  if (!err) console.log('[Kiosk] Removed decorations via xprop');
                });
              }
            });
          }
        } else {
          console.log('[Kiosk] Removed window decorations via wmctrl');
        }

        // Step 3: Keep window above others
        exec('wmctrl -r "Spotify" -b add,above', () => {
          // Step 4: Set window position and size
          exec(`wmctrl -r "Spotify" -e 0,${x},${y},${windowWidth},${windowHeight}`, (err) => {
            if (!err) {
              console.log('[Kiosk] Positioned Spotify as 90% overlay');
            } else {
              console.log('[Kiosk] Could not position Spotify window:', err.message);
            }
          });
        });
      });
    });
  });
}

// Get list of available apps
app.get('/api/kiosk/apps', async (req, res) => {
  const availableApps = [];
  
  for (const [id, config] of Object.entries(kioskApps)) {
    let available = false;
    let availableCommand = null;
    
    for (const cmd of config.commands) {
      const baseCmd = cmd.split(' ')[0];
      if (await commandExists(baseCmd)) {
        available = true;
        availableCommand = cmd;
        break;
      }
    }
    
    availableApps.push({
      id,
      name: config.name,
      available,
      command: availableCommand,
      webUrl: config.webUrl
    });
  }
  
  res.json({ apps: availableApps });
});

// Focus/bring to front a window (using wmctrl if available)
app.post('/api/kiosk/focus/:appId', async (req, res) => {
  const { appId } = req.params;
  const appConfig = kioskApps[appId];
  
  if (!appConfig) {
    return res.status(404).json({ success: false, error: `Unknown app: ${appId}` });
  }

  // Try to focus using wmctrl
  const wmctrlExists = await commandExists('wmctrl');
  if (wmctrlExists) {
    exec(`wmctrl -a "${appConfig.name}"`, (error) => {
      if (error) {
        res.json({ success: false, error: 'Window not found' });
      } else {
        res.json({ success: true });
      }
    });
  } else {
    res.json({ success: false, error: 'wmctrl not installed' });
  }
});

// Return to kiosk browser (focus chromium/firefox)
app.post('/api/kiosk/return-home', async (req, res) => {
  const wmctrlExists = await commandExists('wmctrl');
  
  if (wmctrlExists) {
    // Try to focus common browser windows
    const browsers = ['Radio', 'Chromium', 'Chrome', 'Firefox', 'localhost'];
    
    for (const browser of browsers) {
      try {
        await new Promise((resolve, reject) => {
          exec(`wmctrl -a "${browser}"`, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        return res.json({ success: true, focused: browser });
      } catch (e) {
        // Try next browser
      }
    }
    
    res.json({ success: false, error: 'Browser window not found' });
  } else {
    // Alternative: use xdotool if available
    const xdotoolExists = await commandExists('xdotool');
    if (xdotoolExists) {
      exec('xdotool search --name "Radio" windowactivate', (error) => {
        res.json({ success: !error });
      });
    } else {
      res.json({ success: false, error: 'No window manager tools available' });
    }
  }
});

// Get kiosk status
app.get('/api/kiosk/status', (req, res) => {
  res.json({
    launchedApps,
    timestamp: new Date().toISOString()
  });
});

// Radio control - play station by ID
app.post('/api/radio/play/:stationId', (req, res) => {
  const { stationId } = req.params;
  console.log(`[Radio] Broadcasting play command for station: ${stationId}`);
  broadcast({ type: 'radio-command', action: 'play', stationId });
  res.json({ ok: true, stationId });
});

// Radio control - stop playback
app.post('/api/radio/stop', (req, res) => {
  console.log('[Radio] Broadcasting stop command');
  broadcast({ type: 'radio-command', action: 'stop' });
  res.json({ ok: true });
});

// Close an external app window
app.post('/api/kiosk/close/:appId', async (req, res) => {
  const { appId } = req.params;
  const appInfo = launchedApps[appId];

  console.log(`[Kiosk] Closing ${appId}${appInfo ? ` (tracked PID: ${appInfo.pid})` : ' (not tracked)'}`);

  try {
    // For Spotify specifically, use pkill since it's a snap with multiple processes
    if (appId === 'spotify') {
      exec('pkill -9 spotify', (err) => {
        if (err) {
          console.log('[Kiosk] pkill spotify returned:', err.message);
        } else {
          console.log('[Kiosk] Killed Spotify processes via pkill');
        }
      });
    } else if (appInfo?.pid) {
      // Try to kill the tracked process
      try {
        process.kill(appInfo.pid, 'SIGTERM');
      } catch (e) {
        console.log(`[Kiosk] Could not kill PID ${appInfo.pid}:`, e.message);
      }
    }

    // Also try wmctrl to close the window
    const appConfig = kioskApps[appId];
    if (appConfig) {
      const wmctrlExists = await commandExists('wmctrl');
      if (wmctrlExists) {
        exec(`wmctrl -c "${appConfig.name}"`, () => {});
        if (appConfig.webUrl) {
          exec(`wmctrl -c "${appConfig.webUrl}"`, () => {});
        }
      }
    }

    // Remove from tracked apps
    delete launchedApps[appId];

    res.json({ success: true, message: `Closed ${appId}` });
  } catch (e) {
    console.error(`[Kiosk] Failed to close ${appId}:`, e.message);
    // Still remove from tracking
    delete launchedApps[appId];
    res.json({ success: true, message: 'Removed from tracking' });
  }
});

// Track external URL window
let externalUrlWindow = null;

// Open a URL in a new Firefox window
app.post('/api/kiosk/open-url', (req, res) => {
  const { url, title } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL required' });
  }

  console.log(`[Kiosk] Opening external URL: ${url}`);

  try {
    // Close any existing external window first
    if (externalUrlWindow) {
      try {
        process.kill(externalUrlWindow.pid, 'SIGTERM');
      } catch (e) {}
    }

    // Launch Firefox with the URL in a new window
    const child = spawn('firefox', ['--new-window', url], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();

    externalUrlWindow = {
      pid: child.pid,
      url,
      title,
      openedAt: new Date().toISOString()
    };

    res.json({ success: true, pid: child.pid });
  } catch (e) {
    console.error('[Kiosk] Failed to open URL:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Close the external URL window
app.post('/api/kiosk/close-url', async (req, res) => {
  console.log('[Kiosk] Closing external URL window');

  if (externalUrlWindow) {
    try {
      process.kill(externalUrlWindow.pid, 'SIGTERM');
    } catch (e) {
      console.log('[Kiosk] Process already closed');
    }

    // Also try wmctrl to close Firefox windows that aren't the kiosk
    const wmctrlExists = await commandExists('wmctrl');
    if (wmctrlExists) {
      // Close any Firefox window that's not localhost:3001
      exec('wmctrl -l | grep -i firefox', (err, stdout) => {
        if (!err && stdout) {
          const lines = stdout.trim().split('\n');
          lines.forEach(line => {
            // Don't close the main kiosk window
            if (!line.includes('localhost') && !line.includes('Radio')) {
              const windowId = line.split(/\s+/)[0];
              exec(`wmctrl -i -c ${windowId}`, () => {});
            }
          });
        }
      });
    }

    externalUrlWindow = null;
  }

  // Focus back on the kiosk window
  const wmctrlExists = await commandExists('wmctrl');
  if (wmctrlExists) {
    exec('wmctrl -a "localhost" || wmctrl -a "Radio" || wmctrl -a "Firefox"', () => {});
  }

  res.json({ success: true });
});

// Toggle virtual keyboard (wvkbd)
app.post('/api/kiosk/keyboard/toggle', (req, res) => {
  exec('pkill -SIGUSR2 wvkbd-mobintl', (error) => {
    if (error) {
      console.log('[Kiosk] Keyboard toggle - wvkbd may not be running');
    }
    res.json({ success: true, message: 'Keyboard toggled' });
  });
});

// ============================================
// SYSTEM VOLUME CONTROL
// ============================================

// Helper: Find Spotify's sink-input ID
function getSpotifySinkInput() {
  return new Promise((resolve) => {
    exec('pactl list sink-inputs', (error, stdout) => {
      if (error) return resolve(null);

      // Parse sink-inputs to find Spotify
      const blocks = stdout.split('Sink Input #');
      for (const block of blocks) {
        if (block.includes('application.name = "Spotify"') ||
            block.includes('application.process.binary = "spotify"')) {
          const idMatch = block.match(/^(\d+)/);
          if (idMatch) return resolve(idMatch[1]);
        }
      }
      resolve(null);
    });
  });
}

// Helper: Get Spotify's current volume (0-100)
function getSpotifyVolume(sinkInputId) {
  return new Promise((resolve) => {
    exec('pactl list sink-inputs', (error, stdout) => {
      if (error) return resolve(null);

      const blocks = stdout.split('Sink Input #');
      for (const block of blocks) {
        if (block.startsWith(sinkInputId + '\n') || block.startsWith(sinkInputId + '\r')) {
          const volMatch = block.match(/Volume:.*?(\d+)%/);
          if (volMatch) return resolve(parseInt(volMatch[1]));
        }
      }
      resolve(null);
    });
  });
}

// Helper: Set Spotify's volume via PulseAudio
function setSpotifyVolume(sinkInputId, percent) {
  return new Promise((resolve) => {
    exec(`pactl set-sink-input-volume ${sinkInputId} ${percent}%`, (error) => {
      resolve(!error);
    });
  });
}

// Track Spotify volume for bidirectional sync
let lastSpotifyAppVolume = null;
let spotifySinkInputId = null;

// Poll Spotify's volume and sync to system if changed
setInterval(async () => {
  // Find Spotify sink input if not cached or verify it's still valid
  if (!spotifySinkInputId) {
    spotifySinkInputId = await getSpotifySinkInput();
  }

  if (spotifySinkInputId) {
    const spotifyVol = await getSpotifyVolume(spotifySinkInputId);

    if (spotifyVol !== null) {
      // If Spotify volume changed externally, sync to system
      if (lastSpotifyAppVolume !== null && spotifyVol !== lastSpotifyAppVolume) {
        console.log(`[Volume] Spotify app changed: ${lastSpotifyAppVolume}% -> ${spotifyVol}%, syncing system`);

        // Set system volume to match Spotify
        const wpctlExists = await commandExists('wpctl');
        if (wpctlExists) {
          exec(`wpctl set-volume @DEFAULT_AUDIO_SINK@ ${(spotifyVol / 100).toFixed(2)}`);
        } else {
          exec(`pactl set-sink-volume @DEFAULT_SINK@ ${spotifyVol}%`);
        }
      }
      lastSpotifyAppVolume = spotifyVol;
    } else {
      // Spotify stopped playing, clear cache
      spotifySinkInputId = null;
    }
  }
}, 3000); // Poll every 3 seconds for Spotify volume sync

// Get current system volume
app.get('/api/volume', async (req, res) => {
  exec('pactl get-sink-volume @DEFAULT_SINK@', (error, stdout) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to get volume' });
    }
    const match = stdout.match(/(\d+)%/);
    const volume = match ? parseInt(match[1]) : 0;

    exec('pactl get-sink-mute @DEFAULT_SINK@', (err2, stdout2) => {
      const muted = stdout2?.includes('yes') || false;
      res.json({ volume, muted });
    });
  });
});

// Set system volume
app.put('/api/volume/:percent', async (req, res) => {
  const percent = Math.max(0, Math.min(100, parseInt(req.params.percent)));

  exec(`pactl set-sink-volume @DEFAULT_SINK@ ${percent}%`, (error) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to set volume' });
    }
    res.json({ success: true, volume: percent });
  });
});

// Toggle mute
app.post('/api/volume/mute/toggle', async (req, res) => {
  exec('pactl set-sink-mute @DEFAULT_SINK@ toggle', (error) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to toggle mute' });
    }
    res.json({ success: true });
  });
});

// ============================================
// BLUETOOTH DEVICE MANAGEMENT
// ============================================

// Bluetooth addresses arrive from the network, so they are validated before
// they reach any subprocess.
const BT_ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const isBluetoothAddress = (address) => typeof address === 'string' && BT_ADDRESS.test(address);

// Helper: Execute bluetoothctl command.
// Takes discrete arguments and uses execFile, so no shell parses them and a
// value like "; rm -rf ~" is passed through as a literal argument.
function bluetoothctl(...args) {
  return new Promise((resolve, reject) => {
    execFile('bluetoothctl', args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Helper: Parse bluetoothctl devices output
function parseDevices(output, type = 'paired') {
  const devices = [];
  const lines = output.split('\n');
  for (const line of lines) {
    // Format: "Device AA:BB:CC:DD:EE:FF Device Name"
    const match = line.match(/Device\s+([A-F0-9:]{17})\s+(.+)/i);
    if (match) {
      devices.push({
        address: match[1],
        name: match[2].trim(),
        type
      });
    }
  }
  return devices;
}

// Helper: Get device connection status
async function getDeviceInfo(address) {
  if (!isBluetoothAddress(address)) return null;
  try {
    const output = await bluetoothctl('info', address);
    const connected = output.includes('Connected: yes');
    const paired = output.includes('Paired: yes');
    const trusted = output.includes('Trusted: yes');
    const nameMatch = output.match(/Name:\s*(.+)/);
    const iconMatch = output.match(/Icon:\s*(.+)/);
    return {
      connected,
      paired,
      trusted,
      name: nameMatch ? nameMatch[1].trim() : null,
      icon: iconMatch ? iconMatch[1].trim() : null
    };
  } catch {
    return { connected: false, paired: false, trusted: false };
  }
}

// Get all Bluetooth devices (paired and available)
app.get('/api/bluetooth/devices', async (req, res) => {
  try {
    // Check if bluetoothctl exists
    const btExists = await commandExists('bluetoothctl');
    if (!btExists) {
      return res.status(503).json({ error: 'bluetoothctl not found' });
    }

    // Get paired devices
    const pairedOutput = await bluetoothctl('devices', 'Paired');
    const pairedDevices = parseDevices(pairedOutput, 'paired');

    // Get connection status for each paired device
    const devicesWithStatus = await Promise.all(
      pairedDevices.map(async (device) => {
        const info = await getDeviceInfo(device.address);
        return {
          ...device,
          connected: info.connected,
          trusted: info.trusted,
          icon: info.icon
        };
      })
    );

    // Sort: connected first, then by name
    devicesWithStatus.sort((a, b) => {
      if (a.connected !== b.connected) return b.connected ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    res.json({ devices: devicesWithStatus });
  } catch (e) {
    console.error('[Bluetooth] Error listing devices:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Scan for new devices
app.post('/api/bluetooth/scan', async (req, res) => {
  try {
    const btExists = await commandExists('bluetoothctl');
    if (!btExists) {
      return res.status(503).json({ error: 'bluetoothctl not found' });
    }

    // Start scanning (runs for 10 seconds)
    console.log('[Bluetooth] Starting scan...');
    exec('bluetoothctl --timeout 10 scan on', (error) => {
      if (error) {
        console.log('[Bluetooth] Scan ended');
      }
    });

    res.json({ success: true, message: 'Scanning for 10 seconds...' });
  } catch (e) {
    console.error('[Bluetooth] Scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Connect to a device
app.post('/api/bluetooth/connect/:address', async (req, res) => {
  const { address } = req.params;
  if (!isBluetoothAddress(address)) {
    return res.status(400).json({ error: 'Invalid Bluetooth address' });
  }
  console.log(`[Bluetooth] Connecting to ${address}...`);

  try {
    const btExists = await commandExists('bluetoothctl');
    if (!btExists) {
      return res.status(503).json({ error: 'bluetoothctl not found' });
    }

    // Trust the device first (for auto-reconnect)
    await bluetoothctl('trust', address);

    // Connect
    await bluetoothctl('connect', address);

    console.log(`[Bluetooth] Connected to ${address}`);
    res.json({ success: true, message: 'Connected' });
  } catch (e) {
    console.error(`[Bluetooth] Connect error for ${address}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Disconnect from a device
app.post('/api/bluetooth/disconnect/:address', async (req, res) => {
  const { address } = req.params;
  if (!isBluetoothAddress(address)) {
    return res.status(400).json({ error: 'Invalid Bluetooth address' });
  }
  console.log(`[Bluetooth] Disconnecting from ${address}...`);

  try {
    const btExists = await commandExists('bluetoothctl');
    if (!btExists) {
      return res.status(503).json({ error: 'bluetoothctl not found' });
    }

    await bluetoothctl('disconnect', address);

    console.log(`[Bluetooth] Disconnected from ${address}`);
    res.json({ success: true, message: 'Disconnected' });
  } catch (e) {
    console.error(`[Bluetooth] Disconnect error for ${address}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get Bluetooth adapter status
app.get('/api/bluetooth/status', async (req, res) => {
  try {
    const btExists = await commandExists('bluetoothctl');
    if (!btExists) {
      return res.status(503).json({ error: 'bluetoothctl not found', available: false });
    }

    const output = await bluetoothctl('show');
    // (no user input reaches this call)
    const powered = output.includes('Powered: yes');
    const discovering = output.includes('Discovering: yes');
    const nameMatch = output.match(/Name:\s*(.+)/);

    res.json({
      available: true,
      powered,
      discovering,
      adapterName: nameMatch ? nameMatch[1].trim() : 'Unknown'
    });
  } catch (e) {
    console.error('[Bluetooth] Status error:', e.message);
    res.status(500).json({ error: e.message, available: false });
  }
});

// Power on/off Bluetooth adapter
app.post('/api/bluetooth/power/:state', async (req, res) => {
  const { state } = req.params;
  const powerState = state === 'on' ? 'on' : 'off';

  try {
    const btExists = await commandExists('bluetoothctl');
    if (!btExists) {
      return res.status(503).json({ error: 'bluetoothctl not found' });
    }

    await bluetoothctl('power', powerState);
    console.log(`[Bluetooth] Power ${powerState}`);
    res.json({ success: true, powered: powerState === 'on' });
  } catch (e) {
    console.error('[Bluetooth] Power error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SYSTEM CONTROL (RESTART/SHUTDOWN)
// ============================================

// Restart the kiosk service
app.post('/api/system/restart-kiosk', (req, res) => {
  console.log('[System] Restarting kiosk...');

  // Send response before restarting
  res.json({ success: true, message: 'Restarting kiosk...' });

  // Give the response time to be sent
  setTimeout(() => {
    // Try systemctl first (if running as service), then pkill
    exec('systemctl --user restart kitchen-radio-kiosk 2>/dev/null || pkill -f "node.*server.js"', (error) => {
      if (error) {
        console.log('[System] Restart via systemctl failed, trying alternative...');
        // If that fails, just exit - the service manager should restart us
        process.exit(0);
      }
    });
  }, 500);
});

// Reboot the entire system
app.post('/api/system/reboot', (req, res) => {
  console.log('[System] Rebooting system...');

  res.json({ success: true, message: 'Rebooting system...' });

  setTimeout(() => {
    exec('sudo reboot', (error) => {
      if (error) {
        console.error('[System] Reboot failed:', error.message);
      }
    });
  }, 500);
});

// Shutdown the system
app.post('/api/system/shutdown', (req, res) => {
  console.log('[System] Shutting down system...');

  res.json({ success: true, message: 'Shutting down...' });

  setTimeout(() => {
    exec('sudo shutdown -h now', (error) => {
      if (error) {
        console.error('[System] Shutdown failed:', error.message);
      }
    });
  }, 500);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

// Get current playback state (for when Web Playback SDK isn't available)
app.get('/api/spotify/playback-state', async (req, res) => {
  if (!spotifyTokens.accessToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': `Bearer ${spotifyTokens.accessToken}` }
    });
    if (response.status === 204) {
      return res.json({ is_playing: false, device: null, item: null });
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
