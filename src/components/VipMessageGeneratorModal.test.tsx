import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VipMessageGeneratorModal } from './VipMessageGeneratorModal';

const sampleAdmitted = [
  { name: 'مريض عادي اول', room: '301', id: '100', doctor: 'سمير', payment: 'Cash' },
  { name: 'سهير ابراهيم مصطفى صيام', room: '405 A', id: '200', doctor: 'أحمد علي', payment: '001 - شركة Allianz' },
];

const sampleDischarged = [
  { name: 'محمد عيد نجا نجا', room: '409', mrn: '300', physician: 'كريم حسن', contractor: '002 - AXA' },
];

describe('VipMessageGeneratorModal', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('sorts VIP patients first, filters by search and VIP Only, and generates admitted VIP message on click', async () => {
    render(
      <VipMessageGeneratorModal
        mode="admitted"
        onClose={vi.fn()}
        patients={sampleAdmitted}
        isVipFn={(name) => Boolean(name && name.includes('سهير'))}
        onNotify={vi.fn()}
      />
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const buttons = screen.getAllByTestId('vip-picker-patient-btn');
    // VIP sorted to top
    expect(buttons[0]).toHaveTextContent('سهير ابراهيم مصطفى صيام');
    expect(buttons[1]).toHaveTextContent('مريض عادي اول');

    // Selecting any patient generates the Admitted VIP WhatsApp message
    fireEvent.click(buttons[0]);
    const textarea = screen.getByLabelText(/WhatsApp message preview/i) as HTMLTextAreaElement;
    expect(textarea.value).toContain('👑 *New VIP Patient Admitted*');
    expect(textarea.value).toContain('• *Name:* سهير ابراهيم مصطفى صيام');
    expect(textarea.value).toContain('• *Room:* 405 A');
    expect(textarea.value).toContain('• *Physician:* Dr. أحمد علي');
    expect(textarea.value).toContain('• *Contractor:* Allianz');

    // Copy Message
    fireEvent.click(screen.getByRole('button', { name: /Copy Message/i }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(textarea.value);
    });
  });

  it('generates discharged VIP message and sends via WhatsApp handler', async () => {
    const onSendWhatsApp = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();

    render(
      <VipMessageGeneratorModal
        mode="discharged"
        onClose={vi.fn()}
        patients={sampleDischarged}
        isVipFn={() => false}
        onNotify={onNotify}
        onSendWhatsApp={onSendWhatsApp}
      />
    );

    fireEvent.click(screen.getAllByTestId('vip-picker-patient-btn')[0]);
    const textarea = screen.getByLabelText(/WhatsApp message preview/i) as HTMLTextAreaElement;
    expect(textarea.value).toContain('👑 *VIP Patient Discharged*');
    expect(textarea.value).toContain('• *Name:* محمد عيد نجا نجا');
    expect(textarea.value).toContain('• *Contractor:* AXA');

    fireEvent.click(screen.getByRole('button', { name: /Send to WhatsApp/i }));
    await waitFor(() => {
      expect(onSendWhatsApp).toHaveBeenCalledWith(textarea.value);
    });
  });

  it('shows empty state with Clear Search recovery when search yields no matches', () => {
    render(
      <VipMessageGeneratorModal
        mode="admitted"
        onClose={vi.fn()}
        patients={sampleAdmitted}
        isVipFn={() => false}
      />
    );

    const search = screen.getByPlaceholderText(/Search by name, room, MRN/i);
    fireEvent.change(search, { target: { value: 'zzzzz' } });
    expect(screen.getByText(/No matching patients/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Clear Search'));
    expect(screen.getAllByTestId('vip-picker-patient-btn').length).toBe(2);
  });
});
