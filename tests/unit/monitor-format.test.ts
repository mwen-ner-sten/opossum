import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatHeld,
  formatRelative,
  latencyRatio,
  summarizeStatuses,
} from '../../src/renderer/src/features/monitor/format';

const NOW = Date.parse('2026-09-03T12:00:00Z');
const at = (offsetSeconds: number): string => new Date(NOW + offsetSeconds * 1000).toISOString();

describe('formatRelative', () => {
  it('renders past and future offsets in the smallest useful unit', () => {
    expect(formatRelative(at(-12), NOW)).toBe('12 s ago');
    expect(formatRelative(at(18), NOW)).toBe('in 18 s');
    expect(formatRelative(at(-125), NOW)).toBe('2 min ago');
    expect(formatRelative(at(-3_900), NOW)).toBe('1 h 5 min ago');
  });
  it('falls back to a clock time beyond a day and a dash when missing', () => {
    expect(formatRelative(undefined, NOW)).toBe('—');
    expect(formatRelative(at(-90_000), NOW)).toMatch(/\d/);
  });
});

describe('formatDuration', () => {
  it('switches from milliseconds to seconds at one second', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(42.4)).toBe('42 ms');
    expect(formatDuration(4_600)).toBe('4.60 s');
  });
});

describe('latencyRatio', () => {
  it('reports the fraction of the timeout consumed, clamped to one', () => {
    expect(latencyRatio(undefined, 5)).toBe(0);
    expect(latencyRatio(2_500, 5)).toBe(0.5);
    expect(latencyRatio(9_000, 5)).toBe(1);
    expect(latencyRatio(100, 0)).toBe(0);
  });
});

describe('formatHeld', () => {
  it('reports minutes, hours, and days, and nothing under a minute', () => {
    expect(formatHeld(undefined, NOW)).toBeUndefined();
    expect(formatHeld(at(-30), NOW)).toBeUndefined();
    expect(formatHeld(at(-250), NOW)).toBe('4 min');
    expect(formatHeld(at(-7_500), NOW)).toBe('2 h 05 min');
    expect(formatHeld(at(-100_000), NOW)).toBe('1 d 3 h');
  });
});

describe('summarizeStatuses', () => {
  const base = { PASS: 0, FAIL: 0, CHECKING: 0, UNKNOWN: 0, PAUSED: 0, blocked: 0 };
  it('leads with problems and mentions passing only alongside them', () => {
    expect(summarizeStatuses({ ...base, PASS: 3 })).toBe('All passing');
    expect(summarizeStatuses(base)).toBe('No checks');
    expect(summarizeStatuses({ ...base, FAIL: 3, blocked: 2, PASS: 1 })).toBe(
      '1 failing · 2 blocked · 1 passing',
    );
    expect(summarizeStatuses({ ...base, CHECKING: 1, PAUSED: 2 })).toBe('1 checking · 2 paused');
  });
});
