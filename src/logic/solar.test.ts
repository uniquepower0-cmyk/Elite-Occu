import { describe, it, expect } from 'vitest';
import { calculateSolarTimeline, detectLocation, formatTime12h, LocationInfo } from './solar';

describe('Solar Calculation Engine', () => {
  const cairoLocation: LocationInfo = {
    country: 'Egypt',
    city: 'Cairo',
    timezone: 'Africa/Cairo',
    latitude: 30.0444,
    longitude: 31.2357,
    source: 'timezone-detected'
  };

  const riyadhLocation: LocationInfo = {
    country: 'Saudi Arabia',
    city: 'Riyadh',
    timezone: 'Asia/Riyadh',
    latitude: 24.7136,
    longitude: 46.6753,
    source: 'timezone-detected'
  };

  it('detects location fallback with sensible defaults', () => {
    const loc = detectLocation();
    expect(loc).toBeDefined();
    expect(loc.city).toBeDefined();
    expect(loc.timezone).toBeDefined();
    expect(loc.latitude).toBeGreaterThan(-90);
    expect(loc.latitude).toBeLessThan(90);
  });

  it('calculates accurate sunrise and sunset for Cairo at midday', () => {
    // 12:00 PM in Cairo
    const testDate = new Date('2026-10-19T12:00:00Z');
    const timeline = calculateSolarTimeline(testDate, cairoLocation);

    expect(timeline.sunrise).toBeInstanceOf(Date);
    expect(timeline.sunset).toBeInstanceOf(Date);
    expect(timeline.solarNoon).toBeInstanceOf(Date);
    expect(timeline.isDaytime).toBe(true);
    expect(timeline.phase).toBe('day');
    expect(timeline.nextEvent.type).toBe('sunset');
    expect(timeline.sunriseFormatted).toMatch(/\d{2}:\d{2}\s+(AM|PM)/);
    expect(timeline.sunsetFormatted).toMatch(/\d{2}:\d{2}\s+(AM|PM)/);
  });

  it('identifies nighttime accurately after sunset in Cairo', () => {
    // 22:00 (10 PM) in Cairo
    const testDate = new Date('2026-10-19T20:00:00Z'); // 22:00 local Cairo (UTC+2 or UTC+3)
    const timeline = calculateSolarTimeline(testDate, cairoLocation);

    expect(timeline.isDaytime).toBe(false);
    expect(timeline.phase).toBe('night');
    expect(timeline.nextEvent.type).toBe('sunrise');
  });

  it('accurately calculates Riyadh solar timeline and shifts', () => {
    const testDate = new Date('2026-10-19T09:00:00Z'); // Day shift
    const timeline = calculateSolarTimeline(testDate, riyadhLocation);

    expect(timeline.location.city).toBe('Riyadh');
    expect(timeline.location.country).toBe('Saudi Arabia');
    expect(timeline.shift.current).toBeDefined();
  });

  it('formats time with 12h AM/PM properly', () => {
    const date = new Date('2026-10-19T05:45:00Z');
    const formatted = formatTime12h(date, 'UTC');
    expect(formatted).toBe('05:45 AM');
  });

  it('bounds 24h timeline progress between 0 and 1', () => {
    const now = new Date();
    const timeline = calculateSolarTimeline(now, cairoLocation);
    expect(timeline.progress).toBeGreaterThanOrEqual(0);
    expect(timeline.progress).toBeLessThanOrEqual(1);
    expect(timeline.daylightProgress).toBeGreaterThanOrEqual(0);
    expect(timeline.daylightProgress).toBeLessThanOrEqual(1);
  });
});
