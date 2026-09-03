// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusStrip } from '../../src/renderer/src/components/StatusStrip';

const counts = { PASS: 3, FAIL: 1, CHECKING: 0, UNKNOWN: 0, PAUSED: 2 };

describe('StatusStrip', () => {
  afterEach(cleanup);
  it('toggles the status filter when a count is clicked', () => {
    const onFilter = vi.fn();
    render(<StatusStrip counts={counts} activeFilter="all" onFilter={onFilter} />);
    fireEvent.click(screen.getByRole('button', { name: /1 fail/ }));
    expect(onFilter).toHaveBeenCalledWith('FAIL');
  });
  it('clears the filter when the active count is clicked again', () => {
    const onFilter = vi.fn();
    render(<StatusStrip counts={counts} activeFilter="FAIL" onFilter={onFilter} />);
    const button = screen.getByRole('button', { name: /1 fail/ });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(onFilter).toHaveBeenCalledWith('all');
  });
});
