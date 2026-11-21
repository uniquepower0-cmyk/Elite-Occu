import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search,
  X,
  User,
  Activity,
  FileSpreadsheet,
  LayoutDashboard,
  RefreshCw,
  Copy,
  Upload,
  ArrowRight,
  Crown,
} from 'lucide-react';
import { PatientRow } from '../logic/occupancy';
import { VipBadge } from './ui/VipBadge';

export interface CommandPaletteAction {
  id: string;
  label: string;
  category: 'Navigation' | 'Report' | 'Action';
  keywords?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  patients: PatientRow[];
  orList: any[];
  actions: CommandPaletteAction[];
  onSelectPatient: (patient: PatientRow) => void;
  onSelectORCase: (orCase: any) => void;
  isVipFn?: (name?: string | null) => boolean;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  patients,
  orList,
  actions,
  onSelectPatient,
  onSelectORCase,
  isVipFn,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      // Focus immediately with no animation delay
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const q = query.toLowerCase().trim();

  const matchingPatients = useMemo(() => {
    if (!q) return patients.slice(0, 5);
    return patients
      .filter(
        (p) =>
          (p.name || '').toLowerCase().includes(q) ||
          (p.room || '').toLowerCase().includes(q) ||
          (p.id || '').toLowerCase().includes(q) ||
          (p.doctor || '').toLowerCase().includes(q) ||
          (p.payment || '').toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [patients, q]);

  const matchingOR = useMemo(() => {
    if (!q) return [];
    return orList
      .filter(
        (c) =>
          String(c.patientName || '').toLowerCase().includes(q) ||
          String(c.surgeonName || '').toLowerCase().includes(q) ||
          String(c.orRoom || '').toLowerCase().includes(q) ||
          String(c.mrn || '').toLowerCase().includes(q) ||
          String(c.engOperationName || c.arOperationName || '').toLowerCase().includes(q)
      )
      .slice(0, 5);
  }, [orList, q]);

  const matchingActions = useMemo(() => {
    if (!q) return actions.slice(0, 8);
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.keywords || '').toLowerCase().includes(q)
    );
  }, [actions, q]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] p-4 bg-slate-950/50 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Global Command Palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl bg-white dark:bg-[#0f201c] rounded-2xl border border-slate-200 dark:border-emerald-500/25 shadow-2xl overflow-hidden flex flex-col max-h-[78vh]">
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-200 dark:border-emerald-500/20">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search patients, rooms, OR cases, reports, or views..."
            aria-label="Search patients, rooms, OR cases, reports, or views"
            className="flex-1 bg-transparent text-sm font-medium text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none border-none!"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-md cursor-pointer"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-bold text-slate-500 bg-slate-100 dark:bg-[#142924] dark:text-slate-300 rounded border border-slate-200 dark:border-emerald-500/20">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="overflow-y-auto p-3 space-y-4 custom-scrollbar">
          {matchingPatients.length > 0 && (
            <div>
              <div className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {q ? `Matching Patients & Rooms (${matchingPatients.length})` : 'Quick Patient Lookup'}
              </div>
              <div className="space-y-1">
                {matchingPatients.map((p, idx) => (
                  <button
                    key={`${p.room}-${p.id}-${idx}`}
                    type="button"
                    onClick={() => {
                      onSelectPatient(p);
                      onClose();
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-emerald-950/60 text-left transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="px-2 py-1 rounded-lg bg-teal-50 dark:bg-emerald-950 text-teal-800 dark:text-emerald-300 font-mono text-xs font-bold shrink-0">
                        {p.room}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate flex items-center gap-1.5">
                          <span className="truncate">{p.name || 'Unnamed Patient'}</span>
                          {isVipFn?.(p.name) && <VipBadge />}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          {p.doctor ? `Dr. ${p.doctor}` : 'No physician'} • {p.payment || 'Unknown'}
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400 opacity-0 group-hover:opacity-100 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {matchingOR.length > 0 && (
            <div>
              <div className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Operating Room Schedule ({matchingOR.length})
              </div>
              <div className="space-y-1">
                {matchingOR.map((c, idx) => (
                  <button
                    key={`or-${c.mrn || idx}`}
                    type="button"
                    onClick={() => {
                      onSelectORCase(c);
                      onClose();
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-emerald-950/60 text-left transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="px-2 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-mono text-xs font-bold shrink-0">
                        {c.orRoom || 'OR'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate flex items-center gap-1.5">
                          <span className="truncate">{c.patientName}</span>
                          {isVipFn?.(c.patientName) && <VipBadge />}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                          {c.surgeonName || 'Surgeon'} • {c.startTime || '--:--'} - {c.endTime || '--:--'}
                        </div>
                      </div>
                    </div>
                    <Activity className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {matchingActions.length > 0 && (
            <div>
              <div className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Views, Reports & Quick Actions
              </div>
              <div className="space-y-1">
                {matchingActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => {
                      action.onSelect();
                      onClose();
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-emerald-950/60 text-left transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-slate-500 dark:text-emerald-400 shrink-0">
                        {action.icon || <LayoutDashboard className="w-4 h-4" />}
                      </span>
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                        {action.label}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono font-semibold text-slate-400 uppercase shrink-0">
                      {action.category}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {matchingPatients.length === 0 &&
            matchingOR.length === 0 &&
            matchingActions.length === 0 && (
              <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
                No patients, rooms, OR cases, or commands matched "{query}".
              </div>
            )}
        </div>
      </div>
    </div>
  );
};
