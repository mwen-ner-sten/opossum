import { describe, expect, it } from 'vitest';
import { assessCapacity } from '@core/capacity';
import { DEFAULT_SETTINGS, type TargetConfig } from '@core/config';

type CheckTweaks = Partial<
  Pick<TargetConfig['checks'][number], 'interval_seconds' | 'timeout_seconds' | 'enabled'>
>;
const site = (index: number, checks = 3, extra: CheckTweaks = {}): TargetConfig => ({
  id: `site-${index}`,
  name: `Site ${index}`,
  host: `10.0.${Math.floor(index / 250)}.${index % 250}`,
  enabled: true,
  checks: Array.from({ length: checks }, (_, position) => ({
    id: `check-${position}`,
    name: `Check ${position}`,
    type: 'ping' as const,
    enabled: true,
    tags: [],
    ...extra,
  })),
});

describe('assessCapacity', () => {
  it('is fine for a handful of sites at the defaults', () => {
    const assessment = assessCapacity(DEFAULT_SETTINGS, [site(1), site(2), site(3)]);
    expect(assessment.level).toBe('ok');
    expect(assessment.checkCount).toBe(9);
    // 9 checks × 5 s timeout / 60 s interval = 0.75 concurrent in the worst case.
    expect(assessment.worstCaseConcurrency).toBeCloseTo(0.75);
    expect(assessment.findings).toEqual([]);
  });

  it('warns and recommends more concurrency when a bad day would saturate the limit', () => {
    const sites = Array.from({ length: 100 }, (_, index) => site(index));
    const assessment = assessCapacity({ ...DEFAULT_SETTINGS, default_interval_seconds: 30 }, sites);
    // 300 checks × 5 / 30 = 50 concurrent needed vs 20 configured.
    expect(assessment.level).toBe('critical');
    expect(assessment.worstCaseConcurrency).toBeCloseTo(50);
    expect(assessment.suggestedConcurrency).toBe(75);
    expect(assessment.suggestedIntervalSeconds).toBeUndefined();
    expect(assessment.findings[0]).toMatch(/50 would need to run at once but only 20/);
  });

  it('suggests a longer interval when even the maximum concurrency would not suffice', () => {
    const sites = Array.from({ length: 1000 }, (_, index) => site(index));
    const assessment = assessCapacity({ ...DEFAULT_SETTINGS, default_interval_seconds: 30 }, sites);
    expect(assessment.level).toBe('critical');
    expect(assessment.suggestedConcurrency).toBe(200);
    expect(assessment.suggestedIntervalSeconds).toBeGreaterThan(30);
    expect(
      assessment.findings.some((finding) => /default interval should rise/.test(finding)),
    ).toBe(true);
  });

  it('flags checks whose interval is too close to their timeout', () => {
    const assessment = assessCapacity(DEFAULT_SETTINGS, [
      site(1, 1, { interval_seconds: 10, timeout_seconds: 5 }),
    ]);
    expect(assessment.level).toBe('warning');
    expect(assessment.findings[0]).toMatch(/interval under 3× the timeout/);
  });

  it('ignores disabled targets and checks', () => {
    const disabled = { ...site(1), enabled: false };
    const assessment = assessCapacity(DEFAULT_SETTINGS, [disabled, site(2, 2, { enabled: false })]);
    expect(assessment.checkCount).toBe(0);
    expect(assessment.level).toBe('ok');
  });
});
