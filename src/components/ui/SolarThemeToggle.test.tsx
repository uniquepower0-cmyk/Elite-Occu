import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { SolarThemeToggle } from './SolarThemeToggle';

describe('SolarThemeToggle Component', () => {
  it('renders the header toggle button with auto mode by default', () => {
    render(
      <ThemeProvider>
        <SolarThemeToggle />
      </ThemeProvider>
    );

    const button = screen.getByRole('button', { name: /Theme and Solar Timeline Settings/i });
    expect(button).toBeInTheDocument();
    expect(screen.getAllByText(/auto/i).length).toBeGreaterThan(0);
  });

  it('opens flyout dialog when clicked and presents mode selector', () => {
    render(
      <ThemeProvider>
        <SolarThemeToggle />
      </ThemeProvider>
    );

    const button = screen.getByRole('button', { name: /Theme and Solar Timeline Settings/i });
    fireEvent.click(button);

    // Dialog should now be open
    expect(screen.getByText(/Theme & Solar Timeline/i)).toBeInTheDocument();
    expect(screen.getByText(/Solar Arc Timeline/i)).toBeInTheDocument();
    expect(screen.getByText(/Auto \(Solar\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Light/i)).toBeInTheDocument();
    expect(screen.getByText(/Dark/i)).toBeInTheDocument();
  });

  it('switches to manual dark mode when Dark button is pressed', () => {
    render(
      <ThemeProvider>
        <SolarThemeToggle />
      </ThemeProvider>
    );

    const toggleButton = screen.getByRole('button', { name: /Theme and Solar Timeline Settings/i });
    fireEvent.click(toggleButton);

    const darkBtn = screen.getByRole('button', { name: /Dark/i });
    fireEvent.click(darkBtn);

    expect(screen.getByText(/Manual override active/i)).toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
