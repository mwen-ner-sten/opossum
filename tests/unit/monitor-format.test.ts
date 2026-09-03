import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRelative,
  latencyRatio,
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
