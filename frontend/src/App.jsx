import { useState } from 'react';
import { RadioProvider, useRadio } from './contexts/RadioContext';
import { WeatherProvider, useWeather } from './contexts/WeatherContext';
import { KioskProvider } from './contexts/KioskContext';
import { SpotifyPlayerProvider } from './contexts/SpotifyPlayerContext';
import { SourcesProvider } from './contexts/SourcesContext';
import { useKeyboard } from './contexts/KeyboardContext';

import Navigation from './components/navigation/Navigation';
import FloatingHomeButton from './components/navigation/FloatingHomeButton';
import KioskSettings from './components/navigation/KioskSettings';
import PlayerBar from './components/player/PlayerBar';
import StationGrid from './components/stations/StationGrid';
import VolumeControl from './components/widgets/VolumeControl';
import NewsTicker from './components/widgets/NewsTicker';
import MixcloudTab from './components/tabs/MixcloudTab';
import SpotifyTab from './components/tabs/SpotifyTab';
import TwitchTab from './components/twitch/TwitchTab';
import KeyboardToggle from './components/KeyboardToggle';
import Screensaver from './components/Screensaver';
import SplashScreen from './components/SplashScreen';
import NewsPanel from './components/panels/NewsPanel';
import WeatherPanel from './components/panels/WeatherPanel';
import SourcesPanel from './components/panels/SourcesPanel';

/** Weather, reduced to a readable glance. Tapping opens the full reading. */
function WeatherGlance({ onOpen }) {
  const { weather } = useWeather();

  return (
    <button
      onClick={onOpen}
      className="tap flex items-center gap-2.5 px-3 seam-r"
      aria-label="Open weather"
    >
      <span className="font-mono text-lg tnum leading-none" style={{ color: 'var(--sig-cyan)' }}>
        {weather ? `${weather.temp}°` : '––'}
      </span>
      <span className="hidden text-left sm:block">
        <span className="block stave-label" style={{ fontSize: 11 }}>
          {weather?.city || 'Weather'}
        </span>
        <span className="block truncate text-[12px] capitalize" style={{ color: 'var(--chalk-3)', maxWidth: 128 }}>
          {weather?.description || '—'}
        </span>
      </span>
    </button>
  );
}

function AppContent() {
  const { activeTab, showScreensaver, dismissScreensaver, triggerScreensaver } = useRadio();
  const { isKeyboardOpen } = useKeyboard();
  const [panel, setPanel] = useState(null);

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--ink)' }}>
      {/* ---- Stave rail ---------------------------------------------------- */}
      <header className="flex flex-shrink-0 items-stretch seam-b" style={{ background: 'var(--ink)' }}>
        <WeatherGlance onOpen={() => setPanel('weather')} />

        <div className="flex-1 overflow-x-auto">
          <Navigation />
        </div>

        <div className="flex items-center gap-px pl-px">
          <VolumeControl />

          <button
            onClick={() => setPanel('sources')}
            className="tap flex items-center justify-center seam-l"
            aria-label="Arrange sources"
            style={{ color: 'var(--chalk-2)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 5h18v2H3zM3 11h12v2H3zM3 17h7v2H3z" />
            </svg>
          </button>

          <button
            onClick={triggerScreensaver}
            className="tap flex items-center justify-center seam-l"
            aria-label="Rest the screen"
            style={{ color: 'var(--chalk-3)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
            </svg>
          </button>

          <KioskSettings />
        </div>
      </header>

      {/* ---- Score --------------------------------------------------------- *
        * The radio and Twitch staves manage their own scrolling, because each
        * holds a list beside something that must stay put — a genre rail, a
        * video stage. The two un-converted staves still scroll as one page.
        */}
      <main className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'radio' && <StationGrid />}
        {activeTab === 'twitch' && <TwitchTab />}

        {(activeTab === 'mixcloud' || activeTab === 'spotify') && (
          <div className="h-full overflow-y-auto">
            {activeTab === 'mixcloud' && <MixcloudTab />}
            {activeTab === 'spotify' && <SpotifyTab />}
          </div>
        )}
      </main>

      {/* ---- Transport ----------------------------------------------------- *
        * Persistent, and outside <main>, so moving between staves never cuts
        * the stream. It draws nothing at all until something is loaded.
        */}
      <PlayerBar />

      {/* ---- Ticker -------------------------------------------------------- */}
      {!isKeyboardOpen && (
        <footer className="flex flex-shrink-0 items-stretch seam-t" style={{ background: 'var(--ink)' }}>
          <button
            onClick={() => setPanel('news')}
            className="tap flex flex-shrink-0 items-center px-3 seam-r stave-label"
            style={{ color: 'var(--sig-cyan)', fontSize: 11 }}
            aria-label="Open news"
          >
            News
          </button>
          <div className="min-w-0 flex-1">
            <NewsTicker />
          </div>
        </footer>
      )}

      {/* ---- Overlays ------------------------------------------------------ */}
      {panel === 'news' && <NewsPanel onClose={() => setPanel(null)} />}
      {panel === 'weather' && <WeatherPanel onClose={() => setPanel(null)} />}
      {panel === 'sources' && <SourcesPanel onClose={() => setPanel(null)} />}

      <FloatingHomeButton />
      <Screensaver isActive={showScreensaver} onDismiss={dismissScreensaver} />
      <SplashScreen />
    </div>
  );
}

function App() {
  return (
    <WeatherProvider>
      <RadioProvider>
        <KioskProvider>
          <SourcesProvider>
            <SpotifyPlayerProvider>
              <AppContent />
              <KeyboardToggle />
            </SpotifyPlayerProvider>
          </SourcesProvider>
        </KioskProvider>
      </RadioProvider>
    </WeatherProvider>
  );
}

export default App;
