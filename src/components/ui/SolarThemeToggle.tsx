import React, { useState, useRef, useEffect } from 'react';
import { 
  Sun, 
  Moon, 
  Sparkles, 
  MapPin, 
  RefreshCw, 
  Clock, 
  Sunrise, 
  Sunset, 
  Check, 
  Compass,
  X
} from 'lucide-react';
import { useTheme, ThemeMode } from '../../context/ThemeContext';
import { motion, AnimatePresence } from 'motion/react';

export const SolarThemeToggle: React.FC = () => {
  const { 
    themeMode, 
    isDark, 
    solarTimeline, 
    setThemeMode, 
    refreshLocation 
  } = useTheme();

  const [isOpen, setIsOpen] = useState(false);
  const [isRefreshingLoc, setIsRefreshingLoc] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && 
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleRefreshLocation = async () => {
    setIsRefreshingLoc(true);
    try {
      await refreshLocation();
    } finally {
      setTimeout(() => setIsRefreshingLoc(false), 500);
    }
  };

  // Label for header button
  const headerButtonText = () => {
    if (themeMode === 'auto') {
      const city = solarTimeline.location.city;
      if (solarTimeline.isDaytime) {
        return `Auto • Sunset ${solarTimeline.sunsetFormatted.replace(/:\d{2}\s/, ' ')} (${city})`;
      } else {
        return `Auto • Sunrise ${solarTimeline.sunriseFormatted.replace(/:\d{2}\s/, ' ')} (${city})`;
      }
    }
    return themeMode === 'dark' ? 'Dark Mode' : 'Light Mode';
  };

  // Calculate position along the visual solar curve (SVG arc)
  // X: 40 to 360 (width 400), Y: inverted parabola peaking at midday (X=200, Y=35)
  const svgWidth = 360;
  const svgHeight = 110;
  const sunX = Math.round(30 + solarTimeline.progress * 300);
  // Parabola for daytime elevation peaking at midday (progress 0.5)
  // When night time (progress < 0.25 or > 0.75), elevation drops below horizon
  const normalizedElevation = Math.sin(solarTimeline.progress * Math.PI);
  const sunY = Math.round(85 - normalizedElevation * 55);

  return (
    <div className="relative inline-block text-left">
      {/* Header Pill Button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Theme and Solar Timeline Settings"
        className={`group relative flex items-center gap-2 px-3 py-1.5 min-h-[40px] rounded-xl text-xs font-semibold tracking-tight transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 shadow-xs border ${
          isDark
            ? 'bg-slate-900/80 hover:bg-slate-800/90 text-slate-200 border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.12)]'
            : 'bg-white/80 hover:bg-white text-slate-700 border-slate-200/80 hover:border-slate-300 shadow-sm'
        }`}
      >
        {/* Dynamic Icon */}
        <div className="relative flex items-center justify-center">
          {themeMode === 'auto' ? (
            <div className="relative flex items-center justify-center">
              {isDark ? (
                <Moon className="w-4 h-4 text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]" />
              ) : (
                <Sun className="w-4 h-4 text-amber-500 drop-shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
              )}
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900 animate-pulse" />
            </div>
          ) : themeMode === 'dark' ? (
            <Moon className="w-4 h-4 text-indigo-400" />
          ) : (
            <Sun className="w-4 h-4 text-amber-500" />
          )}
        </div>

        {/* Status text */}
        <span className="hidden md:inline font-mono text-[11px] font-bold truncate max-w-[190px]">
          {headerButtonText()}
        </span>

        {/* Mode badge */}
        <span
          className={`px-1.5 py-0.5 rounded-md text-[10px] uppercase font-mono tracking-wider font-extrabold ${
            themeMode === 'auto'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
          }`}
        >
          {themeMode}
        </span>
      </button>

      {/* Flyout Popover Card */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={`absolute right-0 mt-2 w-[340px] sm:w-[380px] rounded-2xl p-4 sm:p-5 z-50 shadow-2xl border backdrop-blur-xl ${
              isDark
                ? 'bg-[#0f1d1a]/95 text-slate-100 border-emerald-500/25 shadow-[0_20px_50px_rgba(0,0,0,0.6)]'
                : 'bg-white/95 text-slate-900 border-slate-200/90 shadow-[0_20px_50px_rgba(0,0,0,0.12)]'
            }`}
            role="dialog"
            aria-label="Solar Theme Controls"
          >
            {/* Header with Location Badge */}
            <div className="flex items-start justify-between gap-2 pb-3.5 border-b border-slate-200/60 dark:border-slate-800/80">
              <div>
                <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-500" />
                  <span>Theme & Solar Timeline</span>
                </h3>
                <div className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  <MapPin className="w-3 h-3 text-emerald-500 shrink-0" />
                  <span className="truncate">
                    {solarTimeline.location.city}, {solarTimeline.location.country}
                  </span>
                  <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                    {solarTimeline.location.timezone.split('/')[1] || solarTimeline.location.timezone}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={handleRefreshLocation}
                  disabled={isRefreshingLoc}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Detect GPS location"
                  aria-label="Refresh Location"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingLoc ? 'animate-spin text-emerald-500' : ''}`} />
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  aria-label="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Mode Segmented Control */}
            <div className="mt-3.5">
              <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Operating Mode
              </label>
              <div className="grid grid-cols-3 gap-1 p-1 mt-1 rounded-xl bg-slate-100 dark:bg-slate-900/90 border border-slate-200/60 dark:border-slate-800">
                <button
                  onClick={() => setThemeMode('auto')}
                  className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    themeMode === 'auto'
                      ? 'bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-400/40'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Auto (Solar)</span>
                </button>
                <button
                  onClick={() => setThemeMode('light')}
                  className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    themeMode === 'light'
                      ? 'bg-white dark:bg-slate-800 text-amber-600 dark:text-amber-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5 text-amber-500" />
                  <span>Light</span>
                </button>
                <button
                  onClick={() => setThemeMode('dark')}
                  className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    themeMode === 'dark'
                      ? 'bg-slate-800 text-cyan-400 shadow-sm ring-1 ring-cyan-500/40'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <Moon className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Dark</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 leading-snug">
                {themeMode === 'auto'
                  ? 'Default: Automatically transitions at local sunset & sunrise.'
                  : `Manual override active (${themeMode === 'dark' ? 'Night mode forced' : 'Day mode forced'}).`}
              </p>
            </div>

            {/* Solar Arc Timeline Visualizer */}
            <div className="mt-4 p-3 rounded-xl bg-slate-50/80 dark:bg-slate-900/60 border border-slate-200/50 dark:border-slate-800/80">
              <div className="flex items-center justify-between text-xs font-bold mb-2">
                <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
                  <Compass className="w-3.5 h-3.5 text-emerald-500" />
                  Solar Arc Timeline
                </span>
                <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-extrabold">
                  {solarTimeline.nextEvent.type === 'sunset' ? 'Daytime' : 'Nighttime'}
                </span>
              </div>

              {/* Luminous Celestial Arc SVG */}
              <div className="relative w-full h-[95px] flex items-center justify-center overflow-hidden">
                <svg
                  viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                  className="w-full h-full overflow-visible"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="solarArcGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.4" />
                      <stop offset="50%" stopColor="#38bdf8" stopOpacity="1" />
                      <stop offset="100%" stopColor="#f97316" stopOpacity="0.4" />
                    </linearGradient>
                    <linearGradient id="horizonGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgba(245,158,11,0.2)" />
                      <stop offset="50%" stopColor="rgba(56,189,248,0.3)" />
                      <stop offset="100%" stopColor="rgba(249,115,22,0.2)" />
                    </linearGradient>
                  </defs>

                  {/* Horizon ground line */}
                  <line
                    x1="20"
                    y1="85"
                    x2="340"
                    y2="85"
                    stroke={isDark ? '#1e293b' : '#e2e8f0'}
                    strokeWidth="2"
                    strokeDasharray="4 4"
                  />

                  {/* Celestial Arc (Day Path) */}
                  <path
                    d="M 30,85 Q 180,-15 330,85"
                    fill="none"
                    stroke="url(#solarArcGrad)"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />

                  {/* Sunrise Node */}
                  <circle cx="30" cy="85" r="4.5" fill="#f59e0b" className="animate-pulse" />
                  <text x="30" y="102" fontSize="9" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">
                    {solarTimeline.sunriseFormatted.replace(/:\d{2}\s/, ' ')}
                  </text>

                  {/* Midday Sun Node */}
                  <circle cx="180" cy="35" r="5" fill="#38bdf8" />
                  <text x="180" y="24" fontSize="9" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">
                    Noon
                  </text>

                  {/* Sunset Node */}
                  <circle cx="330" cy="85" r="4.5" fill="#f97316" />
                  <text x="330" y="102" fontSize="9" textAnchor="middle" fill="#94a3b8" fontFamily="monospace">
                    {solarTimeline.sunsetFormatted.replace(/:\d{2}\s/, ' ')}
                  </text>

                  {/* Live Position Marker */}
                  <g transform={`translate(${sunX}, ${sunY})`}>
                    <circle
                      r="9"
                      fill={isDark ? 'rgba(34,211,238,0.25)' : 'rgba(245,158,11,0.25)'}
                      className="animate-ping"
                    />
                    <circle
                      r="5.5"
                      fill={isDark ? '#22d3ee' : '#f59e0b'}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                    />
                  </g>
                </svg>
              </div>

              {/* Sunrise / Sunset Metric Row */}
              <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-slate-200/50 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center text-amber-500 shrink-0">
                    <Sunrise className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400 font-mono">Sunrise</span>
                    <span className="text-xs font-mono font-bold text-slate-800 dark:text-slate-200">
                      {solarTimeline.sunriseFormatted}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-orange-500/15 flex items-center justify-center text-orange-500 shrink-0">
                    <Sunset className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400 font-mono">Sunset</span>
                    <span className="text-xs font-mono font-bold text-slate-800 dark:text-slate-200">
                      {solarTimeline.sunsetFormatted}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Hospital Shift Indicator */}
            <div className="mt-3 flex items-center justify-between px-3 py-2 rounded-xl bg-emerald-500/10 dark:bg-emerald-950/40 border border-emerald-500/20 text-xs">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  {solarTimeline.shift.label}
                </span>
                <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                  ({solarTimeline.shift.hours})
                </span>
              </div>
              <span className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400">
                Next: {solarTimeline.nextEvent.type === 'sunset' ? 'Sunset' : 'Sunrise'} in {Math.floor(solarTimeline.nextEvent.minutesUntil / 60)}h {solarTimeline.nextEvent.minutesUntil % 60}m
              </span>
            </div>

            {/* Reset to Auto Link if currently Manual */}
            {themeMode !== 'auto' && (
              <button
                onClick={() => setThemeMode('auto')}
                className="w-full mt-2.5 py-1.5 text-center text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer flex items-center justify-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Reset to Auto Solar Schedule
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
