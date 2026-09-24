// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerdictSummary } from '@core/verdict';
import { VerdictBar } from '../../src/renderer/src/features/monitor/VerdictBar';

const summary = (counts: Partial<VerdictSummary['counts']>): VerdictSummary => {
  const full = {
    broke: 0,
    still_failing: 0,
    new_failure: 0,
    blocked: 0,
    recovered: 0,
    ok: 0,
    pending: 0,
    paused: 0,
    ...counts,
  };
  return {
    counts: full,
    active: Object.values(full).reduce((sum, value) => sum + value, 0) - full.paused,
    baselineFrom: '2026-09-23T10:00:00.000Z',
    baselineTo: '2026-09-23T10:00:00.000Z',
  };
};

describe('VerdictBar', () => {
  afterEach(cleanup);

  it('headlines regressions and filters to them', () => {
    const onFilter = vi.fn();
    render(
      <VerdictBar
        summary={summary({ broke: 2, ok: 5 })}
        activeFilter="all"
        onFilter={onFilter}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.getByText('2 checks broke since last session')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Recovered/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /2 Broke/ }));
    expect(onFilter).toHaveBeenCalledWith('broke');
  });

  it('clears the filter from the active chip and copies the verdict', () => {
    const onFilter = vi.fn();
    const onCopy = vi.fn();
    render(
      <VerdictBar
        summary={summary({ ok: 3 })}
        activeFilter="ok"
        onFilter={onFilter}
        onCopy={onCopy}
      />,
    );
    expect(screen.getByText('Everything that passed before passes now')).toBeInTheDocument();
    const chip = screen.getByRole('button', { name: /3 OK/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(onFilter).toHaveBeenCalledWith('all');
    fireEvent.click(screen.getByRole('button', { name: /Copy verdict/ }));
    expect(onCopy).toHaveBeenCalled();
  });

  it('renders nothing when every check is paused', () => {
    const { container } = render(
      <VerdictBar
        summary={summary({ paused: 4 })}
        activeFilter="all"
        onFilter={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
