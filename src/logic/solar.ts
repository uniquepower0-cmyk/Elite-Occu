/**
 * Solar Calculation & Astronomical Timeline Engine
 * Accurately calculates Sunrise, Sunset, Solar Noon, and Day/Night cycle
 * using the standard NOAA astronomical solar equations.
 * Includes timezone resolution and geolocation detection.
 */

export interface LocationInfo {
  country: string;
  city: string;
  timezone: string;
  latitude: number;
  longitude: number;
  source: 'gps' | 'timezone-detected' | 'fallback';
}

export interface SolarTimeline {
  sunrise: Date;
  sunset: Date;
  solarNoon: Date;
  dawn: Date; // Civil twilight begin
  dusk: Date; // Civil twilight end
  sunriseFormatted: string;
  sunsetFormatted: string;
  solarNoonFormatted: string;
  isDaytime: boolean;
  isTwilight: boolean;
  phase: 'day' | 'night' | 'twilight';
  progress: number; // 0.0 - 1.0 representing position along 24h timeline
  daylightProgress: number; // 0.0 - 1.0 representing daylight portion (0 at sunrise, 1 at sunset)
  nextEvent: {
    type: 'sunrise' | 'sunset';
    timeFormatted: string;
    minutesUntil: number;
  };
  shift: {
    current: 'day-shift' | 'night-duty';
    label: string;
    hours: string;
  };
  location: LocationInfo;
}

// Well-known coordinates for regional hospital hubs
const TIMEZONE_COORDINATE_MAP: Record<string, { country: string; city: string; lat: number; lon: number }> = {
  'Africa/Cairo': { country: 'Egypt', city: 'Cairo', lat: 30.0444, lon: 31.2357 },
  'Asia/Riyadh': { country: 'Saudi Arabia', city: 'Riyadh', lat: 24.7136, lon: 46.6753 },
  'Asia/Jeddah': { country: 'Saudi Arabia', city: 'Jeddah', lat: 21.5433, lon: 39.1728 },
  'Asia/Dubai': { country: 'United Arab Emirates', city: 'Dubai', lat: 25.2048, lon: 55.2708 },
  'Asia/Kuwait': { country: 'Kuwait', city: 'Kuwait City', lat: 29.3759, lon: 47.9774 },
  'Asia/Doha': { country: 'Qatar', city: 'Doha', lat: 25.2854, lon: 51.5310 },
  'Asia/Bahrain': { country: 'Bahrain', city: 'Manama', lat: 26.2285, lon: 50.5860 },
  'Asia/Muscat': { country: 'Oman', city: 'Muscat', lat: 23.5880, lon: 58.3829 },
  'Asia/Amman': { country: 'Jordan', city: 'Amman', lat: 31.9454, lon: 35.9284 },
  'Asia/Beirut': { country: 'Lebanon', city: 'Beirut', lat: 33.8938, lon: 35.5018 },
  'Europe/London': { country: 'United Kingdom', city: 'London', lat: 51.5074, lon: -0.1278 },
  'Europe/Paris': { country: 'France', city: 'Paris', lat: 48.8566, lon: 2.3522 },
  'Europe/Berlin': { country: 'Germany', city: 'Berlin', lat: 52.5200, lon: 13.4050 },
  'America/New_York': { country: 'United States', city: 'New York', lat: 40.7128, lon: -74.0060 },
  'America/Los_Angeles': { country: 'United States', city: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  'America/Chicago': { country: 'United States', city: 'Chicago', lat: 41.8781, lon: -87.6298 },
  'Asia/Tokyo': { country: 'Japan', city: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  'Asia/Singapore': { country: 'Singapore', city: 'Singapore', lat: 1.3521, lon: 103.8198 },
  'Australia/Sydney': { country: 'Australia', city: 'Sydney', lat: -33.8688, lon: 151.2093 }
};

/**
 * Detects location and timezone from the browser environment
 */
export function detectLocation(): LocationInfo {
  let timezone = 'Africa/Cairo';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo';
  } catch {
    timezone = 'Africa/Cairo';
  }

  if (TIMEZONE_COORDINATE_MAP[timezone]) {
    const info = TIMEZONE_COORDINATE_MAP[timezone];
    return {
      country: info.country,
      city: info.city,
      timezone,
      latitude: info.lat,
      longitude: info.lon,
      source: 'timezone-detected'
    };
  }

  // Parse region/city from timezone string e.g. "Asia/Riyadh" -> City "Riyadh", Country from Region
  const parts = timezone.split('/');
  const city = (parts[parts.length - 1] || 'Cairo').replace(/_/g, ' ');
  let country = parts[0] || 'Egypt';
  if (country === 'Africa') country = 'Egypt';
  else if (country === 'Asia') country = 'Saudi Arabia';

  return {
    country,
    city,
    timezone,
    latitude: 30.0444,
    longitude: 31.2357,
    source: 'fallback'
  };
}

/**
 * Degrees to radians helper
 */
const degToRad = (deg: number) => (deg * Math.PI) / 180.0;
const radToDeg = (rad: number) => (rad * 180.0) / Math.PI;

/**
 * Standard NOAA solar calculation for sunrise, sunset, and solar noon
 */
function calculateSunTimes(date: Date, latitude: number, longitude: number, zenith: number = 90.833) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // Day of the year
  const N1 = Math.floor((275 * month) / 9);
  const N2 = Math.floor((month + 9) / 12);
  const N3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
  const dayOfYear = N1 - N2 * N3 + day - 30;

  // Approximate sunrise & sunset time in days
  const lngHour = longitude / 15.0;

  const calculateForZenith = (isSunrise: boolean, customZenith: number) => {
    const t = isSunrise
      ? dayOfYear + (6.0 - lngHour) / 24.0
      : dayOfYear + (18.0 - lngHour) / 24.0;

    // Sun's mean anomaly
    const M = 0.9856 * t - 3.289;

    // Sun's true longitude
    let L =
      M +
      1.916 * Math.sin(degToRad(M)) +
      0.02 * Math.sin(degToRad(2 * M)) +
      282.634;
    L = (L + 360) % 360;

    // Sun's right ascension
    let RA = radToDeg(Math.atan(0.91764 * Math.tan(degToRad(L))));
    RA = (RA + 360) % 360;

    // RA quadrant adjustment
    const Lquadrant = Math.floor(L / 90) * 90;
    const RAquadrant = Math.floor(RA / 90) * 90;
    RA = RA + (Lquadrant - RAquadrant);
    RA = RA / 15.0;

    // Sun's declination
    const sinDec = 0.39782 * Math.sin(degToRad(L));
    const cosDec = Math.cos(Math.asin(sinDec));

    // Sun's local hour angle
    const cosH =
      (Math.cos(degToRad(customZenith)) - sinDec * Math.sin(degToRad(latitude))) /
      (cosDec * Math.cos(degToRad(latitude)));

    if (cosH > 1) {
      // Polar night - sun never rises
      return null;
    }
    if (cosH < -1) {
      // Midnight sun - sun never sets
      return null;
    }

    const H = isSunrise
      ? 360.0 - radToDeg(Math.acos(cosH))
      : radToDeg(Math.acos(cosH));
    const Hhours = H / 15.0;

    // Local mean time of rising/setting
    const T = Hhours + RA - 0.06571 * t - 6.622;

    // Universal Coordinated Time (UTC)
    let UT = (T - lngHour + 24) % 24;

    const resDate = new Date(Date.UTC(year, month - 1, day));
    const hours = Math.floor(UT);
    const minutes = Math.floor((UT - hours) * 60);
    const seconds = Math.floor(((UT - hours) * 60 - minutes) * 60);
    resDate.setUTCHours(hours, minutes, seconds, 0);

    return resDate;
  };

  const sunrise = calculateForZenith(true, zenith) || new Date(date.getFullYear(), date.getMonth(), date.getDate(), 6, 0);
  const sunset = calculateForZenith(false, zenith) || new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18, 0);
  const dawn = calculateForZenith(true, 96.0) || new Date(sunrise.getTime() - 30 * 60000); // Civil twilight
  const dusk = calculateForZenith(false, 96.0) || new Date(sunset.getTime() + 30 * 60000);

  // Solar noon is roughly the midpoint between sunrise and sunset
  const solarNoon = new Date((sunrise.getTime() + sunset.getTime()) / 2);

  return { sunrise, sunset, solarNoon, dawn, dusk };
}

/**
 * Format date to 12-hour AM/PM string with timezone
 */
export function formatTime12h(date: Date, timezone?: string): string {
  try {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone
    });
  } catch {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = hours % 12 || 12;
    return `${formattedHours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  }
}

/**
 * Computes full solar timeline for a given location and date
 */
export function calculateSolarTimeline(
  now: Date = new Date(),
  customLocation?: LocationInfo
): SolarTimeline {
  const location = customLocation || detectLocation();
  const { sunrise, sunset, solarNoon, dawn, dusk } = calculateSunTimes(
    now,
    location.latitude,
    location.longitude
  );

  const nowMs = now.getTime();
  const sunriseMs = sunrise.getTime();
  const sunsetMs = sunset.getTime();
  const dawnMs = dawn.getTime();
  const duskMs = dusk.getTime();

  const isDaytime = nowMs >= sunriseMs && nowMs < sunsetMs;
  const isTwilight =
    (nowMs >= dawnMs && nowMs < sunriseMs) ||
    (nowMs >= sunsetMs && nowMs < duskMs);

  const phase: 'day' | 'night' | 'twilight' = isTwilight
    ? 'twilight'
    : isDaytime
    ? 'day'
    : 'night';

  // 24-hour progress (0.0 to 1.0 from midnight to midnight)
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const progress = Math.min(
    Math.max((nowMs - startOfDay.getTime()) / (24 * 3600 * 1000), 0),
    1
  );

  // Daylight progress (0 at sunrise to 1 at sunset)
  let daylightProgress = 0;
  if (isDaytime) {
    daylightProgress = Math.min(
      Math.max((nowMs - sunriseMs) / (sunsetMs - sunriseMs), 0),
      1
    );
  } else if (nowMs < sunriseMs) {
    daylightProgress = 0;
  } else {
    daylightProgress = 1;
  }

  // Next transition event
  let nextEvent: { type: 'sunrise' | 'sunset'; timeFormatted: string; minutesUntil: number };
  if (isDaytime) {
    const minutesUntil = Math.max(0, Math.round((sunsetMs - nowMs) / 60000));
    nextEvent = {
      type: 'sunset',
      timeFormatted: formatTime12h(sunset, location.timezone),
      minutesUntil
    };
  } else {
    let nextSunriseMs = sunriseMs;
    let nextSunriseDate = sunrise;
    if (nowMs >= sunsetMs) {
      // Next sunrise is tomorrow morning
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowTimes = calculateSunTimes(tomorrow, location.latitude, location.longitude);
      nextSunriseMs = tomorrowTimes.sunrise.getTime();
      nextSunriseDate = tomorrowTimes.sunrise;
    }
    const minutesUntil = Math.max(0, Math.round((nextSunriseMs - nowMs) / 60000));
    nextEvent = {
      type: 'sunrise',
      timeFormatted: formatTime12h(nextSunriseDate, location.timezone),
      minutesUntil
    };
  }

  // Hospital clinical shift calculation:
  // Day Shift: 07:00 - 19:00
  // Night Duty: 19:00 - 07:00
  const currentHour = now.getHours();
  const isNightShift = currentHour >= 19 || currentHour < 7;
  const shift = {
    current: isNightShift ? ('night-duty' as const) : ('day-shift' as const),
    label: isNightShift ? 'Night Duty' : 'Day Shift',
    hours: isNightShift ? '19:00 – 07:00' : '07:00 – 19:00'
  };

  return {
    sunrise,
    sunset,
    solarNoon,
    dawn,
    dusk,
    sunriseFormatted: formatTime12h(sunrise, location.timezone),
    sunsetFormatted: formatTime12h(sunset, location.timezone),
    solarNoonFormatted: formatTime12h(solarNoon, location.timezone),
    isDaytime,
    isTwilight,
    phase,
    progress,
    daylightProgress,
    nextEvent,
    shift,
    location
  };
}
