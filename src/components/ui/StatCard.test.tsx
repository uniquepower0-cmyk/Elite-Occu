import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { StatCard } from './StatCard';
import { Activity } from 'lucide-react';

describe('StatCard component', () => {
  it('renders label, value, and subValue properly', () => {
    render(
      <StatCard
        label="Total Occupied"
        value="42 / 60"
        subValue="Active patient beds"
        icon={<Activity data-testid="stat-icon" />}
      />
    );

    expect(screen.getByText('42 / 60')).toBeInTheDocument();
    expect(screen.getByText('Total Occupied')).toBeInTheDocument();
    expect(screen.getByText('Active patient beds')).toBeInTheDocument();
    expect(screen.getByTestId('stat-icon')).toBeInTheDocument();
  });

  it('handles copy callback when onCopy prop is provided', () => {
    const handleCopy = vi.fn();

    render(
      <StatCard
        label="VIP Cases"
        value="3"
        subValue="Active VIP cases"
        icon={<Activity />}
        onCopy={handleCopy}
        copyLabel="Copy VIP List"
      />
    );

    const copyBtn = screen.getByTitle('Copy VIP List');
    expect(copyBtn).toBeInTheDocument();

    fireEvent.click(copyBtn);
    expect(handleCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Copied!')).toBeInTheDocument();
  });
});
