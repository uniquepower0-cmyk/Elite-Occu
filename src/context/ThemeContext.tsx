import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { calculateSolarTimeline, detectLocation, LocationInfo, SolarTimeline } from '../logic/solar';

export type ThemeMode = 'auto' | 'light' | 'dark';

interface ThemeContextType {
  themeMode: ThemeMode;
  isDark: boolean;
  solarTimeline: SolarTimeline;
  setThemeMode: (mode: ThemeMode) => void;
  toggleQuick: () => void;
  resetToAuto: () => void;
  refreshLocation: () => Promise<void>;
  customLocation: LocationInfo | null;
}

const STORAGE_KEY = 'elite_hospital_theme_mode';

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Mode: defaults to 'auto' as requested
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'auto' || saved === 'light' || saved === 'dark') {
        return saved;
      }
    } catch {
      // ignore storage access errors
    }
    return 'auto';
  });

  const [customLocation, setCustomLocation] = useState<LocationInfo | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());

  // Periodically refresh the time and solar timeline every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  // Compute solar timeline based on current time & detected location
  const solarTimeline = useMemo(() => {
    return calculateSolarTimeline(now, customLocation || undefined);
  }, [now, customLocation]);

  // Determine whether dark theme is active:
  // In 'auto' mode: active if sunset has passed (not daytime)
  // In 'light' mode: false
  // In 'dark' mode: true
  const isDark = useMemo(() => {
    if (themeMode === 'auto') {
      return !solarTimeline.isDaytime;
    }
    return themeMode === 'dark';
  }, [themeMode, solarTimeline.isDaytime]);

  // Synchronize with DOM element & CSS variables
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.setAttribute('data-theme', 'light');
      root.style.colorScheme = 'light';
    }
  }, [isDark]);

  // Persist mode choice
  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  const resetToAuto = useCallback(() => {
    setThemeMode('auto');
  }, [setThemeMode]);

  const toggleQuick = useCallback(() => {
    // Quick toggle flips between light and dark, switching mode to manual
    setThemeMode(isDark ? 'light' : 'dark');
  }, [isDark, setThemeMode]);

  // Request high-precision GPS if available
  const refreshLocation = useCallback(async () => {
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      try {
        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const base = detectLocation();
              setCustomLocation({
                country: base.country,
                city: base.city,
                timezone: base.timezone,
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                source: 'gps'
              });
              setNow(new Date());
              resolve();
            },
            (err) => reject(err),
            { timeout: 5000 }
          );
        });
      } catch {
        // Fallback to auto-detected timezone
        setCustomLocation(detectLocation());
        setNow(new Date());
      }
    } else {
      setCustomLocation(detectLocation());
      setNow(new Date());
    }
  }, []);

  const value = useMemo(
    () => ({
      themeMode,
      isDark,
      solarTimeline,
      setThemeMode,
      toggleQuick,
      resetToAuto,
      refreshLocation,
      customLocation
    }),
    [
      themeMode,
      isDark,
      solarTimeline,
      setThemeMode,
      toggleQuick,
      resetToAuto,
      refreshLocation,
      customLocation
    ]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    const fallbackSolar = calculateSolarTimeline();
    return {
      themeMode: 'auto',
      isDark: !fallbackSolar.isDaytime,
      solarTimeline: fallbackSolar,
      setThemeMode: () => {},
      toggleQuick: () => {},
      resetToAuto: () => {},
      refreshLocation: async () => {},
      customLocation: null,
    };
  }
  return context;
}
