// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckConfig, TargetConfig } from '@core/config';
import type { CheckResult, LiveCheckState } from '@core/models';
import { targetHealth } from '../../src/renderer/src/features/monitor/board';
import { TargetBlock } from '../../src/renderer/src/features/monitor/TargetBlock';

const check = (id: string, name: string): CheckConfig => ({
  id,
  name,
  type: 'tcp',
  port: 80,
  enabled: true,
  tags: [],
});
const target: TargetConfig = {
  id: 'den-01',
  name: 'Denver BMS 01',
  host: '10.0.0.1',
  enabled: true,
  checks: [check('host', 'Host reachable'), check('web', 'WebStation')],
};
const result = (status: 'PASS' | 'FAIL', category: CheckResult['category'], summary: string) => ({
  status,
  category,
  summary,
  startedAt: '2026-09-24T12:00:00.000Z',
  completedAt: '2026-09-24T12:00:00.000Z',
  durationMs: 5,
});
const states: LiveCheckState[] = [
  {
    targetId: 'den-01',
    checkId: 'host',
    status: 'FAIL',
    result: result('FAIL', 'connection_refused', 'Connection refused'),
    lastKnown: { targetId: 'den-01', checkId: 'host', result: result('PASS', 'success', 'OK') },
    isHistorical: false,
  },
  {
    targetId: 'den-01',
    checkId: 'web',
    status: 'FAIL',
    result: result('FAIL', 'blocked', 'Blocked: Host reachable is failing'),
    isHistorical: false,
  },
];

function renderBlock(expanded: boolean, handlers: Partial<Record<string, () => void>> = {}) {
  const onSelectCheck = vi.fn();
  render(
    <TargetBlock
      target={target}
      checks={target.checks}
      states={states}
      health={targetHealth(states)}
      expanded={expanded}
      selectedCheckId={undefined}
      missingVariables={[]}
      defaultTimeoutSeconds={5}
      onToggle={handlers.onToggle ?? vi.fn()}
      onSelectCheck={onSelectCheck}
      onEdit={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
  return { onSelectCheck };
}

describe('TargetBlock', () => {
  afterEach(cleanup);

  it('shows only the root failure and a Broke flag while collapsed', () => {
    const { onSelectCheck } = renderBlock(false);
    const issue = screen.getByRole('button', { name: /Host reachable Connection refused/ });
    expect(issue).toHaveTextContent('+1 more');
    expect(screen.getByText('Broke')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show details for/ })).not.toBeInTheDocument();
    fireEvent.click(issue);
    expect(onSelectCheck).toHaveBeenCalledWith('host');
  });

  it('lists every check row when expanded and toggles from the name', () => {
    const onToggle = vi.fn();
    renderBlock(true, { onToggle });
    expect(
      screen.getByRole('button', { name: 'Show details for Denver BMS 01 WebStation' }),
    ).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Collapse Denver BMS 01' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalled();
  });
});
