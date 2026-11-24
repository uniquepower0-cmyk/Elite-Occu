import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  HeartPulse,
  Microscope,
  RefreshCw,
  Search,
  Zap,
} from 'lucide-react';
import type { ProcedureCaseItem, ProceduresDataResponse } from '../types';
import { VipBadge } from './ui/VipBadge';

interface ProceduresScheduleViewProps {
  isVipFn?: (name?: string | null) => boolean;
}

type UnitFilter = 'all' | 'cathlab' | 'endoscopy';
type WindowMode = 'today' | 'upcoming' | 'recent' | 'all';

function formatSyncTime(iso?: string | null): string {
  if (!iso) return 'Not synced';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateLabel(isoDate: string): string {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : isoDate || '—';
}

function parseTimeMinutes(timeStr: string): number {
  if (!timeStr) return 9999;
  const s = String(timeStr).trim().toLowerCase();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return 9999;
  let h = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  const isPM = s.includes('pm') || s.includes('م');
  const isAM = s.includes('am') || s.includes('ص');
  if (isPM && h < 12) h += 12;
  else if (isAM && h === 12) h = 0;
  return h * 60 + mins;
}

function cleanOpLabel(raw: string): string {
  return String(raw || '')
    .replace(/\s*\/\/\s*s-[^\s/]+\/*\s*/gi, '')
    .replace(/\s*\/\/+\s*$/, '')
    .trim();
}

export const ProceduresScheduleView: React.FC<ProceduresScheduleViewProps> = ({ isVipFn }) => {
  const [data, setData] = useState<ProceduresDataResponse>({ cathlab: null, endoscopy: null });
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [unitFilter, setUnitFilter] = useState<UnitFilter>('all');
  const [windowMode, setWindowMode] = useState<WindowMode>('today');
  const [specificDate, setSpecificDate] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [downloadingUnit, setDownloadingUnit] = useState<'cathlab' | 'endoscopy' | null>(null);

  const handleDownloadRefined = async (unit: 'cathlab' | 'endoscopy') => {
    const exportDate = specificDate || referenceDate;
    setDownloadingUnit(unit);
    setError(null);
    try {
      const endpoint = unit === 'endoscopy' ? '/api/reports/endoscopy_refined' : '/api/reports/cathlab_refined';
      const res = await fetch(`${endpoint}?date=${encodeURIComponent(exportDate)}`);
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${unit === 'endoscopy' ? 'Endoscopy_List' : 'CathLab_List'}_${exportDate}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || `Failed to download ${unit} sheet`);
    } finally {
      setDownloadingUnit(null);
    }
  };

  const loadProcedures = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(force ? '/api/procedures/data?refresh=1' : '/api/procedures/data');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ProceduresDataResponse = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Cath Lab & Endoscopy schedules');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadProcedures(false);
  }, []);

  const referenceDate =
    data.cathlab?.referenceDate ||
    data.endoscopy?.referenceDate ||
    new Date().toISOString().slice(0, 10);

  const combinedItems = useMemo(() => {
    const out: Array<ProcedureCaseItem & { unit: 'cathlab' | 'endoscopy' }> = [];
    if (unitFilter === 'all' || unitFilter === 'cathlab') {
      for (const item of data.cathlab?.items || []) {
        out.push({ ...item, unit: 'cathlab' });
      }
    }
    if (unitFilter === 'all' || unitFilter === 'endoscopy') {
      for (const item of data.endoscopy?.items || []) {
        out.push({ ...item, unit: 'endoscopy' });
      }
    }
    return out.sort((a, b) => {
      const dCmp = String(b.procedureDate || '').localeCompare(String(a.procedureDate || ''));
      if (dCmp !== 0) return dCmp;
      return parseTimeMinutes(a.startTime) - parseTimeMinutes(b.startTime);
    });
  }, [data, unitFilter]);

  const availableDates = useMemo(() => {
    return Array.from(new Set(combinedItems.map((c) => c.procedureDate).filter(Boolean))).sort().reverse();
  }, [combinedItems]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return combinedItems.filter((item) => {
      if (specificDate) {
        if (item.procedureDate !== specificDate) return false;
      } else if (windowMode === 'today') {
        if (item.procedureDate !== referenceDate) return false;
      } else if (windowMode === 'upcoming') {
        if (item.procedureDate <= referenceDate) return false;
      } else if (windowMode === 'recent') {
        if (item.procedureDate >= referenceDate) return false;
      }
      if (q) {
        const hay = `${item.patientName} ${item.mrn} ${item.surgeonName} ${item.engOperationName} ${item.arOperationName} ${item.room} ${item.contractorName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [combinedItems, windowMode, specificDate, referenceDate, searchQuery]);

  const cathSum = data.cathlab?.summary;
  const endoSum = data.endoscopy?.summary;
  const todayTotal = (cathSum?.todayCount || 0) + (endoSum?.todayCount || 0);
  const inProgressTotal = (cathSum?.inProgressCount || 0) + (endoSum?.inProgressCount || 0);
  const completedTodayTotal = (cathSum?.completedTodayCount || 0) + (endoSum?.completedTodayCount || 0);
  const upcomingTotal = (cathSum?.upcomingCount || 0) + (endoSum?.upcomingCount || 0);
  const recentTotal = (cathSum?.recentCount || 0) + (endoSum?.recentCount || 0);
  const latestUpdatedAt = data.cathlab?.updatedAt || data.endoscopy?.updatedAt || null;
  const isStale = Boolean(data.cathlab?.isStale && data.endoscopy?.isStale);

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200 dark:border-emerald-500/20">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50 tracking-tight">
              Cath Lab &amp; Endoscopy Schedules
            </h3>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-500/30">
              <Clock className="w-3 h-3" />
              On-Premises Auto-Sync · {formatSyncTime(latestUpdatedAt)}
            </span>
            {isStale && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/50 dark:text-amber-300">
                <AlertTriangle className="w-3 h-3" />
                Stale (&gt;4h)
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Rolling 14-day schedule window ({formatDateLabel(data.cathlab?.windowStart || '')} → {formatDateLabel(data.cathlab?.windowEnd || '')}) isolated from Surgical OR
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => handleDownloadRefined('endoscopy')}
            disabled={downloadingUnit !== null || loading}
            title={`Download Refined Endoscopy List for ${formatDateLabel(specificDate || referenceDate)}`}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            {downloadingUnit === 'endoscopy' ? 'Generating...' : `Endoscopy List (${formatDateLabel(specificDate || referenceDate)})`}
          </button>
          <button
            type="button"
            onClick={() => handleDownloadRefined('cathlab')}
            disabled={downloadingUnit !== null || loading}
            title={`Download Refined Cath Lab List for ${formatDateLabel(specificDate || referenceDate)}`}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-rose-700 hover:bg-rose-800 text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            {downloadingUnit === 'cathlab' ? 'Generating...' : `Cath Lab List (${formatDateLabel(specificDate || referenceDate)})`}
          </button>
          <button
            type="button"
            onClick={() => loadProcedures(true)}
            disabled={refreshing || loading}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-white dark:bg-[#142924] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-emerald-500/25 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
            aria-label="Refresh Cath Lab and Endoscopy schedules"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-500/30 text-rose-800 dark:text-rose-200 text-xs font-medium">
          {error}
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Today&apos;s Procedures</span>
            <Calendar className="w-4 h-4 text-brand-primary" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{todayTotal}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              Cath {cathSum?.todayCount || 0} · Endo {endoSum?.todayCount || 0}
            </span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>In Room Now</span>
            <Activity className="w-4 h-4 text-sky-600 dark:text-sky-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-sky-700 dark:text-sky-400">{inProgressTotal}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {completedTodayTotal} completed today
            </span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Upcoming (Next 7d)</span>
            <HeartPulse className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{upcomingTotal}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              Cath {cathSum?.upcomingCount || 0} · Endo {endoSum?.upcomingCount || 0}
            </span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
            <span>Recent (Past 7d)</span>
            <CheckCircle2 className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{recentTotal}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              Cath {cathSum?.recentCount || 0} · Endo {endoSum?.recentCount || 0}
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg p-0.5 bg-slate-100 dark:bg-[#142924] border border-slate-200 dark:border-emerald-500/20">
            {(
              [
                { id: 'all', label: 'All Units', icon: null },
                { id: 'cathlab', label: 'Cath Lab', icon: HeartPulse },
                { id: 'endoscopy', label: 'Endoscopy', icon: Microscope },
              ] as const
            ).map((u) => {
              const Icon = u.icon;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setUnitFilter(u.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                    unitFilter === u.id
                      ? 'bg-white dark:bg-[#0f201c] text-slate-900 dark:text-slate-50 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {Icon && <Icon className="w-3.5 h-3.5" />}
                  {u.label}
                </button>
              );
            })}
          </div>

          <div className="inline-flex items-center gap-1 flex-wrap">
            {(
              [
                { id: 'today', label: `Today (${todayTotal})` },
                { id: 'upcoming', label: `Upcoming (${upcomingTotal})` },
                { id: 'recent', label: `Recent 7d (${recentTotal})` },
                { id: 'all', label: `All 14d (${combinedItems.length})` },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setWindowMode(m.id);
                  setSpecificDate('');
                }}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-colors ${
                  !specificDate && windowMode === m.id
                    ? 'bg-brand-primary text-white border-brand-primary'
                    : 'bg-white dark:bg-[#0f201c] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-emerald-500/20'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={specificDate}
            onChange={(e) => setSpecificDate(e.target.value)}
            aria-label="Filter by specific date"
            className="px-2.5 py-2 rounded-lg text-xs bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 text-slate-700 dark:text-slate-200 font-mono"
          >
            <option value="">All dates in window</option>
            {availableDates.map((d) => (
              <option key={d} value={d}>
                {formatDateLabel(d)}
              </option>
            ))}
          </select>

          <div className="relative flex-1 sm:w-60">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search patient, MRN, surgeon..."
              className="w-full pl-9 pr-3 py-2 rounded-lg text-xs bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
            />
          </div>
        </div>
      </div>

      {/* Table or Smart Empty State */}
      {loading ? (
        <div className="h-52 rounded-2xl bg-slate-100 dark:bg-[#142924] animate-pulse" />
      ) : filteredItems.length === 0 ? (
        <div className="p-10 rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 text-center space-y-3">
          <Calendar className="w-8 h-8 text-slate-400 mx-auto" />
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            No {unitFilter === 'all' ? 'Cath Lab or Endoscopy' : unitFilter === 'cathlab' ? 'Cath Lab' : 'Endoscopy'} cases for{' '}
            {specificDate ? formatDateLabel(specificDate) : windowMode === 'today' ? `Today (${formatDateLabel(referenceDate)})` : windowMode}
          </p>
          {windowMode === 'today' && !specificDate && (recentTotal > 0 || upcomingTotal > 0) && (
            <div className="flex items-center justify-center gap-2 pt-1">
              {upcomingTotal > 0 && (
                <button
                  type="button"
                  onClick={() => setWindowMode('upcoming')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-primary text-white cursor-pointer"
                >
                  View {upcomingTotal} Upcoming
                </button>
              )}
              {recentTotal > 0 && (
                <button
                  type="button"
                  onClick={() => setWindowMode('recent')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-[#142924] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-emerald-500/20 cursor-pointer"
                >
                  View {recentTotal} Recent (7d)
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 dark:bg-[#142924] border-b border-slate-200 dark:border-emerald-500/20 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4">Date &amp; Time</th>
                  <th className="py-3 px-4">Unit / Room</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Patient &amp; MRN</th>
                  <th className="py-3 px-4">Procedure &amp; Surgeon</th>
                  <th className="py-3 px-4">Payer / Post-Op</th>
                  <th className="py-3 px-4">Dose / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-emerald-500/10 text-xs">
                {filteredItems.map((c, idx) => {
                  const isVip = isVipFn ? isVipFn(c.patientName) : false;
                  const stLower = (c.status || '').toLowerCase();
                  return (
                    <tr key={`${c.unit}-${c.procedureDate}-${c.mrn}-${idx}`} className="hover:bg-slate-50/80 dark:hover:bg-[#142924]/70">
                      <td className="py-3 px-4 whitespace-nowrap font-mono tabular-nums">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {formatDateLabel(c.procedureDate)}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {c.startTime || '—'}{c.endTime ? ` – ${c.endTime}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${
                            c.unit === 'cathlab'
                              ? 'bg-rose-50 text-rose-800 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-500/30'
                              : 'bg-sky-50 text-sky-800 border border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-500/30'
                          }`}
                        >
                          {c.unit === 'cathlab' ? <HeartPulse className="w-3 h-3" /> : <Microscope className="w-3 h-3" />}
                          {c.room || (c.unit === 'cathlab' ? 'Cath Lab' : 'Endoscopy')}
                        </span>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {stLower === 'inor' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-100 text-sky-800 border border-sky-200 dark:bg-sky-950/60 dark:text-sky-300 font-semibold">
                            <Activity className="w-3 h-3" />
                            In Room
                          </span>
                        ) : stLower === 'completed' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 font-semibold">
                            <CheckCircle2 className="w-3 h-3" />
                            Completed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 dark:bg-[#142924] dark:text-slate-300 font-medium">
                            <Clock className="w-3 h-3" />
                            {c.status || 'Scheduled'}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {c.patientName || 'Unnamed'}
                          </span>
                          {isVip && <VipBadge size="sm" />}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                          MRN {c.mrn || '—'}{c.vt ? ` · ${c.vt}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 max-w-xs">
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {cleanOpLabel(c.engOperationName) || cleanOpLabel(c.arOperationName) || '—'}
                        </div>
                        {c.arOperationName && c.engOperationName && (
                          <div className="text-[11px] text-slate-500 dark:text-slate-400" dir="rtl">
                            {cleanOpLabel(c.arOperationName)}
                          </div>
                        )}
                        {c.surgeonName && (
                          <div className="text-[11px] text-brand-primary font-medium mt-0.5">
                            Dr. {c.surgeonName}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-800 dark:text-slate-200 font-medium">
                          {c.contractorName || c.paidBy || '—'}
                        </div>
                        {c.postC && (
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            Post-Op: {c.postC}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 max-w-xs">
                        {c.cathlabDose && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 font-mono text-[11px] font-semibold mb-1">
                            <Zap className="w-3 h-3" />
                            {c.cathlabDose}
                          </span>
                        )}
                        <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-[11px]">
                          {c.operativeComment || c.preparationInstructions || '—'}
                        </p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};
