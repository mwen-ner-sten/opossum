// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../../src/renderer/src/components/StatusBadge';

describe('status presentation', () => {
  it('always includes status text rather than relying on color', () => {
    render(<StatusBadge status="FAIL" />);
    expect(screen.getByText('Fail')).toBeVisible();
  });
});
