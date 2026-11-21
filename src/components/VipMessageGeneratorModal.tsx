import React, { useEffect, useMemo, useState } from 'react';
import { Crown, Search, X, Copy, Check, Send, UserPlus, LogOut } from 'lucide-react';
import { VipBadge } from './ui/VipBadge';
import {
  formatVipAdmissionMessageClient,
  formatVipDischargeMessageClient,
} from '../logic/vip';

export interface VipMessagePatientItem {
  name: string;
  room: string;
  mrn?: string;
  id?: string;
  doctor?: string;
  physician?: string;
  payment?: string;
  contractor?: string;
  isVip?: boolean;
  isVIP?: boolean;
}

export interface VipMessageGeneratorModalProps {
  mode: 'admitted' | 'discharged' | null;
  onClose: () => void;
  patients: VipMessagePatientItem[];
  isVipFn: (name?: string | null) => boolean;
  onNotify?: (msg: string, type?: 'info' | 'success' | 'error') => void;
  onSendWhatsApp?: (message: string) => Promise<void>;
}

export const VipMessageGeneratorModal: React.FC<VipMessageGeneratorModalProps> = ({
  mode,
  onClose,
  patients,
  isVipFn,
  onNotify,
  onSendWhatsApp,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [vipOnly, setVipOnly] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [messageText, setMessageText] = useState('');
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);

  // Reset modal state whenever mode opens/changes
  useEffect(() => {
    if (!mode) return;
    setSearchQuery('');
    setVipOnly(false);
    setSelectedIndex(null);
    setMessageText('');
    setCopied(false);
    setSending(false);
  }, [mode]);

  // Escape key closes modal
  useEffect(() => {
    if (!mode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, onClose]);

  const enrichedPatients = useMemo(() => {
    return (patients || [])
      .filter((p) => p && String(p.name || '').trim().length > 0)
      .map((p) => {
        const vip = Boolean(p.isVip || p.isVIP || isVipFn(p.name));
        return {
          ...p,
          mrnDisplay: String(p.mrn || p.id || '').trim(),
          physicianDisplay: String(p.physician || p.doctor || '').trim(),
          contractorDisplay: String(p.contractor || p.payment || '').trim(),
          vip,
        };
      })
      .sort((a, b) => {
        if (a.vip !== b.vip) return a.vip ? -1 : 1;
        return String(a.room || '').localeCompare(String(b.room || ''), undefined, { numeric: true });
      });
  }, [patients, isVipFn]);

  const vipCount = useMemo(
    () => enrichedPatients.filter((p) => p.vip).length,
    [enrichedPatients]
  );

  const filteredPatients = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return enrichedPatients.filter((p) => {
      if (vipOnly && !p.vip) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        String(p.room || '').toLowerCase().includes(q) ||
        p.mrnDisplay.toLowerCase().includes(q) ||
        p.physicianDisplay.toLowerCase().includes(q) ||
        p.contractorDisplay.toLowerCase().includes(q)
      );
    });
  }, [enrichedPatients, vipOnly, searchQuery]);

  if (!mode) return null;

  const isAdmittedMode = mode === 'admitted';
  const title = isAdmittedMode ? 'Manual VIP Admission Message' : 'Manual VIP Discharge Message';
  const subtitle = isAdmittedMode
    ? 'Choose any admitted patient to generate, edit, copy, or send a VIP admission WhatsApp alert.'
    : 'Choose any discharged patient to generate, edit, copy, or send a VIP discharge WhatsApp alert.';

  const handleSelectPatient = (idx: number, p: (typeof filteredPatients)[number]) => {
    setSelectedIndex(idx);
    setCopied(false);
    const formatted = isAdmittedMode
      ? formatVipAdmissionMessageClient({
          patientName: p.name,
          roomNumber: p.room,
          physician: p.physicianDisplay,
          contractor: p.contractorDisplay,
        })
      : formatVipDischargeMessageClient({
          patientName: p.name,
          roomNumber: p.room,
          contractor: p.contractorDisplay,
        });
    setMessageText(formatted);
  };

  const handleCopy = async () => {
    if (!messageText.trim()) return;
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      onNotify?.('VIP WhatsApp message copied to clipboard.', 'success');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      onNotify?.('Could not copy message to clipboard.', 'error');
    }
  };

  const handleSendWhatsApp = async () => {
    if (!messageText.trim() || sending) return;
    setSending(true);
    try {
      if (onSendWhatsApp) {
        await onSendWhatsApp(messageText);
      } else {
        const res = await fetch('/api/whatsapp/send-vip-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: messageText }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || `Failed to send WhatsApp message (HTTP ${res.status})`);
        }
      }
      onNotify?.('VIP message sent to WhatsApp group.', 'success');
    } catch (err: any) {
      onNotify?.(err?.message || 'Failed to send VIP message to WhatsApp.', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 backdrop-blur-xs p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vip-msg-modal-title"
        className="w-full max-w-4xl max-h-[90vh] bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/25 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-emerald-500/20 flex items-start justify-between gap-4 bg-slate-50/80 dark:bg-[#0b1815]">
          <div className="flex items-start gap-3">
            <div
              className={`p-2.5 rounded-xl border shrink-0 ${
                isAdmittedMode
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-500/30'
                  : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-500/30'
              }`}
            >
              {isAdmittedMode ? <UserPlus size={20} /> : <LogOut size={20} />}
            </div>
            <div>
              <h3
                id="vip-msg-modal-title"
                className="text-base font-extrabold text-slate-900 dark:text-slate-50 flex items-center gap-2"
              >
                <Crown className="w-4 h-4 text-amber-500" />
                {title}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="min-h-11 min-w-11 flex items-center justify-center rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:text-white dark:hover:bg-emerald-950/60 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-emerald-500/20 overflow-hidden">
          {/* Left: Patient Picker */}
          <div className="flex flex-col min-h-0 p-4 gap-3 overflow-hidden">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, room, MRN, doctor, contractor..."
                aria-label="Search patients"
                className="w-full pl-9 pr-8 py-2.5 text-xs font-medium bg-slate-50 dark:bg-[#142924] border border-slate-200 dark:border-emerald-500/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand-primary/40 text-slate-900 dark:text-slate-100 placeholder-slate-400"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setVipOnly(false)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors cursor-pointer ${
                  !vipOnly
                    ? 'bg-brand-primary text-white border-brand-primary'
                    : 'bg-white dark:bg-[#142924] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-emerald-500/20'
                }`}
              >
                All ({enrichedPatients.length})
              </button>
              <button
                type="button"
                onClick={() => setVipOnly(true)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-colors inline-flex items-center gap-1 cursor-pointer ${
                  vipOnly
                    ? 'bg-amber-500 text-white border-amber-500'
                    : 'bg-white dark:bg-[#142924] text-amber-800 dark:text-amber-300 border-amber-300/70 dark:border-amber-500/30'
                }`}
              >
                <Crown className="w-3 h-3" />
                VIP Only ({vipCount})
              </button>
            </div>

            <div className="flex-1 min-h-[220px] max-h-[46vh] overflow-y-auto border border-slate-200 dark:border-emerald-500/20 rounded-xl divide-y divide-slate-100 dark:divide-emerald-500/10 bg-slate-50/40 dark:bg-[#0b1815]/50">
              {filteredPatients.length === 0 ? (
                <div className="py-10 px-4 text-center flex flex-col items-center gap-2">
                  <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                    No matching patients found.
                  </p>
                  {(searchQuery.trim() || vipOnly) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setVipOnly(false);
                      }}
                      className="px-3 py-1.5 text-xs font-bold rounded-lg bg-brand-primary/10 text-brand-primary hover:bg-brand-primary/20 cursor-pointer"
                    >
                      Clear Search
                    </button>
                  )}
                </div>
              ) : (
                filteredPatients.map((p, idx) => {
                  const isSelected = selectedIndex === idx;
                  return (
                    <button
                      key={`${p.mrnDisplay || p.name}-${p.room}-${idx}`}
                      data-testid="vip-picker-patient-btn"
                      type="button"
                      onClick={() => handleSelectPatient(idx, p)}
                      className={`w-full text-left px-3.5 py-2.5 transition-colors cursor-pointer flex flex-col gap-1 ${
                        isSelected
                          ? 'bg-teal-50 dark:bg-emerald-950/70 border-l-4 border-l-brand-primary'
                          : 'hover:bg-white dark:hover:bg-[#142924]/70'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-extrabold text-slate-900 dark:text-slate-100 truncate">
                          {p.name}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {p.vip && <VipBadge />}
                          <span className="px-2 py-0.5 rounded-md bg-teal-500/10 text-teal-800 dark:text-emerald-300 font-mono text-[10px] font-bold">
                            {p.room || '—'}
                          </span>
                        </div>
                      </div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold flex flex-wrap gap-x-3 gap-y-0.5">
                        {p.mrnDisplay && <span>MRN: {p.mrnDisplay}</span>}
                        {p.physicianDisplay && <span>Dr. {p.physicianDisplay}</span>}
                        {p.contractorDisplay && <span className="truncate">{p.contractorDisplay}</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Live Message Preview & Actions */}
          <div className="flex flex-col min-h-0 p-4 gap-3 bg-slate-50/40 dark:bg-[#0b1815]/30">
            <div className="flex items-center justify-between">
              <label
                htmlFor="vip-msg-preview-textarea"
                className="text-xs font-extrabold uppercase tracking-wider text-slate-600 dark:text-slate-300"
              >
                WhatsApp Message Preview
              </label>
              <span className="text-[10px] font-semibold text-slate-400">
                Editable before copy / send
              </span>
            </div>

            <textarea
              id="vip-msg-preview-textarea"
              aria-label="WhatsApp message preview"
              dir="auto"
              rows={11}
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder={
                isAdmittedMode
                  ? 'Select an admitted patient on the left to generate the VIP admission message...'
                  : 'Select a discharged patient on the left to generate the VIP discharge message...'
              }
              className="flex-1 min-h-[220px] w-full text-xs font-mono leading-relaxed p-3.5 rounded-xl border border-slate-200 dark:border-emerald-500/25 bg-white dark:bg-[#142924] text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-primary/40 resize-none"
            />

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleCopy}
                disabled={!messageText.trim()}
                className={`min-h-11 px-4 py-2 rounded-xl text-xs font-extrabold transition-all flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  copied
                    ? 'bg-emerald-600 text-white'
                    : 'bg-brand-primary hover:bg-brand-hover text-white shadow-sm'
                }`}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy Message'}
              </button>

              <button
                type="button"
                onClick={handleSendWhatsApp}
                disabled={!messageText.trim() || sending}
                className="min-h-11 px-4 py-2 rounded-xl text-xs font-extrabold border border-emerald-600/30 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/60 dark:text-emerald-200 dark:border-emerald-500/40 transition-all flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={14} />
                {sending ? 'Sending...' : 'Send to WhatsApp'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
