import React, { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  Clock,
  Download,
  FileSpreadsheet,
  Filter,
  Layers,
  RefreshCw,
  Search,
  Stethoscope,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { useToast } from '../context/ToastContext';

export interface OPDClinicSession {
  serial: string;
  day: number;
  weekName: string;
  startTime: string;
  endTime: string;
  specialty: string;
  specialities: string;
  physicianEn: string;
  physicianAr: string;
  floorName: string;
  supervisoryLevel: string;
  maxOccupancy: number;
  schedules: number;
  opdDate: string;
}

interface OPDStatusViewProps {
  initialItems?: OPDClinicSession[];
  initialDate?: string;
}

function parseTimeMinutes(str: string): number | null {
  if (!str) return null;
  const lower = str.toLowerCase().trim();
  const isPM = lower.includes('pm') || lower.includes('م');
  const isAM = lower.includes('am') || lower.includes('ص');
  const m = lower.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (isPM && h < 12) h += 12;
  else if (isAM && h === 12) h = 0;
  return h * 60 + min;
}

function formatDateDDMMYYYY(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso || '—';
}

export const OPDStatusView: React.FC<OPDStatusViewProps> = ({
  initialItems = [],
  initialDate = '',
}) => {
  const toast = useToast();
  const [items, setItems] = useState<OPDClinicSession[]>(initialItems);
  const [opdDate, setOpdDate] = useState<string>(initialDate);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(initialItems.length === 0);
  const [uploading, setUploading] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [selectedSpecialty, setSelectedSpecialty] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const fetchOPDData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/opd/data');
      if (res.ok) {
        const data = await res.json();
        setItems(Array.isArray(data.items) ? data.items : []);
        if (data.opdDate) setOpdDate(data.opdDate);
        setSyncError(data.syncError || null);
      }
    } catch (err) {
      console.error('Failed to load OPD data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialItems.length > 0) {
      setItems(initialItems);
      if (initialDate) setOpdDate(initialDate);
      setLoading(false);
    } else {
      fetchOPDData();
    }
  }, [initialItems, initialDate]);

  const handleSync = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/opd/sync', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        setItems(data.items || []);
        if (data.opdDate) setOpdDate(data.opdDate);
        toast.success(`Synced ${data.totalClinics || 0} OPD clinic sessions.`);
      } else {
        toast.error(data.error || 'Failed to sync OPD data.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Network error while syncing OPD data.');
    } finally {
      setLoading(false);
    }
  };

  const handleUploadOPDSheet = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload-opd-list', { method: 'POST', body: fd });
      const data = await res.json();
      if (res.ok && data.success) {
        setItems(data.items || []);
        if (data.opdDate) setOpdDate(data.opdDate);
        toast.success(`Uploaded OPD doctors Sheet (${data.totalClinics} clinics for ${formatDateDDMMYYYY(data.opdDate)}).`);
      } else {
        toast.error(data.error || 'Failed to parse OPD doctors Sheet.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDownload = async (endpoint: string, filename: string, key: string) => {
    setDownloading(key);
    try {
      const res = await fetch(endpoint);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Download failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      toast.error(`Download failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setDownloading(null);
    }
  };

  // Option B: Group by sub-clinic `specialty`
  const specialtyStats = useMemo(() => {
    const map = new Map<string, { specialty: string; count: number; maxOcc: number }>();
    for (const item of items) {
      const key = (item.specialty || item.specialities || 'Other').trim();
      const cur = map.get(key) || { specialty: key, count: 0, maxOcc: 0 };
      cur.count += 1;
      cur.maxOcc += Number(item.maxOccupancy || 0);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.specialty.localeCompare(b.specialty));
  }, [items]);

  const maxSpecialtyCount = useMemo(
    () => Math.max(1, ...specialtyStats.map(s => s.count)),
    [specialtyStats]
  );

  const kpis = useMemo(() => {
    let totalMaxOcc = 0;
    let floor1 = 0;
    let floorM = 0;
    for (const item of items) {
      totalMaxOcc += Number(item.maxOccupancy || 0);
      const fl = String(item.floorName || '').trim().toLowerCase();
      if (fl === '1') floor1++;
      else if (fl === 'm') floorM++;
    }
    return {
      totalClinics: items.length,
      specialtyCount: specialtyStats.length,
      totalMaxOcc,
      floor1,
      floorM,
    };
  }, [items, specialtyStats]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter(item => {
      const sp = (item.specialty || item.specialities || 'Other').trim();
      if (selectedSpecialty && sp !== selectedSpecialty) return false;
      if (!q) return true;
      return (
        sp.toLowerCase().includes(q) ||
        (item.physicianEn || '').toLowerCase().includes(q) ||
        (item.physicianAr || '').toLowerCase().includes(q) ||
        (item.supervisoryLevel || '').toLowerCase().includes(q)
      );
    });
  }, [items, selectedSpecialty, searchQuery]);

  // Timeline bounds: 09:00 AM (540m) to 11:00 PM (1380m) or dynamic min/max
  const timelineBounds = useMemo(() => {
    let minM = 9 * 60;
    let maxM = 22 * 60;
    for (const it of filteredItems) {
      const s = parseTimeMinutes(it.startTime);
      const e = parseTimeMinutes(it.endTime);
      if (s !== null && s < minM) minM = Math.floor(s / 60) * 60;
      if (e !== null && e > maxM) maxM = Math.ceil(e / 60) * 60;
    }
    return { minM, maxM, span: Math.max(60, maxM - minM) };
  }, [filteredItems]);

  const hourTicks = useMemo(() => {
    const ticks: { mins: number; label: string; pct: number }[] = [];
    for (let m = timelineBounds.minM; m <= timelineBounds.maxM; m += 60) {
      const h24 = Math.floor(m / 60) % 24;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      ticks.push({
        mins: m,
        label: `${h12}${ampm}`,
        pct: ((m - timelineBounds.minM) / timelineBounds.span) * 100,
      });
    }
    return ticks;
  }, [timelineBounds]);

  const groupedTimeline = useMemo(() => {
    const map = new Map<string, OPDClinicSession[]>();
    for (const it of filteredItems) {
      const sp = (it.specialty || it.specialities || 'Other').trim();
      const arr = map.get(sp) || [];
      arr.push(it);
      map.set(sp, arr);
    }
    return Array.from(map.entries())
      .map(([specialty, list]) => ({
        specialty,
        sessions: [...list].sort(
          (a, b) => (parseTimeMinutes(a.startTime) ?? 0) - (parseTimeMinutes(b.startTime) ?? 0)
        ),
      }))
      .sort((a, b) => b.sessions.length - a.sessions.length || a.specialty.localeCompare(b.specialty));
  }, [filteredItems]);

  const fileDateTag = opdDate || new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Header & Actions */}
      <div className="bg-white/90 dark:bg-[#0f201c] backdrop-blur-md p-6 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20 shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                <Stethoscope className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-extrabold text-slate-900 dark:text-slate-50 tracking-tight">
                OPD Status &amp; Clinic Housing
              </h2>
              {opdDate && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-50 dark:bg-emerald-950/70 border border-teal-200 dark:border-emerald-500/30 text-teal-800 dark:text-emerald-300 font-mono text-xs font-bold">
                  <Calendar className="w-3.5 h-3.5" />
                  {formatDateDDMMYYYY(opdDate)}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Auto-fetched day by day: purged daily at 10:00 PM Cairo time and replaced with next day&rsquo;s clinics (no OPD history kept), or upload &ldquo;OPD doctors Sheet&rdquo; manually.
            </p>
            {syncError && (
              <div className="mt-2 px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs font-medium">
                Last 10:00 PM OPD sync failed ({syncError}). Retrying automatically or click Refresh.
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#0b3c34] hover:bg-[#0e4e43] text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs">
              <Upload className="w-3.5 h-3.5" />
              <span>{uploading ? 'Uploading...' : 'Upload OPD doctors Sheet'}</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleUploadOPDSheet}
                disabled={uploading}
              />
            </label>

            <button
              type="button"
              onClick={handleSync}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-[#142924] border border-slate-200 dark:border-emerald-500/25 text-slate-700 dark:text-slate-200 hover:bg-slate-50 text-xs font-bold rounded-xl cursor-pointer transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* 3 Downloadable Sheets */}
        <div className="pt-3 border-t border-slate-200/70 dark:border-emerald-500/15 flex flex-wrap items-center gap-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mr-1">
            Export Sheets:
          </span>
          <button
            type="button"
            disabled={items.length === 0 || !!downloading}
            onClick={() => handleDownload('/api/reports/opd_refined', `OPD_Doctors_Schedule_${fileDateTag}.xlsx`, 'refined')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-45 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>{downloading === 'refined' ? 'Generating...' : 'OPD Schedule (جدول العيادات)'}</span>
          </button>

          <button
            type="button"
            disabled={items.length === 0 || !!downloading}
            onClick={() => handleDownload('/api/reports/opd_timeline', `OPD_Timeline_${fileDateTag}.xlsx`, 'timeline')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-45 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs"
          >
            <Clock className="w-3.5 h-3.5" />
            <span>{downloading === 'timeline' ? 'Generating...' : 'OPD Timeline (الجدول الزمني)'}</span>
          </button>

          <button
            type="button"
            disabled={items.length === 0 || !!downloading}
            onClick={() => handleDownload('/api/reports/opd_housing', `OPD_Housing_${fileDateTag}.xlsx`, 'housing')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-45 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{downloading === 'housing' ? 'Generating...' : 'OPD Housing (تسكين العيادات)'}</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#0f201c] p-4 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Total Scheduled Clinics
          </div>
          <div className="text-2xl font-black text-slate-900 dark:text-slate-50 mt-1 font-mono tabular-nums">
            {kpis.totalClinics}
          </div>
        </div>
        <div className="bg-white dark:bg-[#0f201c] p-4 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Active Clinic Specialties
          </div>
          <div className="text-2xl font-black text-emerald-700 dark:text-emerald-400 mt-1 font-mono tabular-nums">
            {kpis.specialtyCount}
          </div>
        </div>
        <div className="bg-white dark:bg-[#0f201c] p-4 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Users className="w-3.5 h-3.5" /> Total Max Occupancy
          </div>
          <div className="text-2xl font-black text-slate-900 dark:text-slate-50 mt-1 font-mono tabular-nums">
            {kpis.totalMaxOcc}
          </div>
        </div>
        <div className="bg-white dark:bg-[#0f201c] p-4 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Layers className="w-3.5 h-3.5" /> Floor Distribution
          </div>
          <div className="text-sm font-bold text-slate-800 dark:text-slate-200 mt-2 font-mono">
            Floor 1: <span className="text-emerald-700 dark:text-emerald-400">{kpis.floor1}</span> · M:{' '}
            <span className="text-teal-700 dark:text-teal-300">{kpis.floorM}</span>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="bg-white dark:bg-[#0f201c] p-12 rounded-2xl border border-dashed border-slate-300 dark:border-emerald-500/25 text-center space-y-2">
          <Stethoscope className="w-9 h-9 text-slate-400 mx-auto" />
          <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
            No OPD Doctors Sheet loaded yet
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Upload an &ldquo;OPD doctors Sheet&rdquo; above or wait for the Python bridge startup / 11:30 PM sync.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left: Numbers of Clinics per Specialty */}
          <div className="xl:col-span-5 bg-white dark:bg-[#0f201c] p-5 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-slate-50">
                  Clinics per Specialty
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Click any specialty to filter the timeline
                </p>
              </div>
              {selectedSpecialty && (
                <button
                  type="button"
                  onClick={() => setSelectedSpecialty(null)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30 text-[11px] font-bold cursor-pointer"
                >
                  <X className="w-3 h-3" /> Clear
                </button>
              )}
            </div>

            <div className="space-y-2 max-h-[540px] overflow-y-auto pr-1 custom-scrollbar">
              {specialtyStats.map(stat => {
                const isSelected = selectedSpecialty === stat.specialty;
                const widthPct = Math.max(8, Math.round((stat.count / maxSpecialtyCount) * 100));
                return (
                  <button
                    key={stat.specialty}
                    type="button"
                    onClick={() => setSelectedSpecialty(isSelected ? null : stat.specialty)}
                    className={`w-full text-left p-2.5 rounded-xl border transition cursor-pointer ${
                      isSelected
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-500 ring-1 ring-emerald-500/40'
                        : 'bg-slate-50/70 dark:bg-[#132822] border-slate-200/70 dark:border-emerald-500/15 hover:border-emerald-400/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs font-bold text-slate-800 dark:text-slate-100">
                      <span className="truncate">{stat.specialty}</span>
                      <span className="font-mono shrink-0 text-emerald-700 dark:text-emerald-400">
                        {stat.count} {stat.count === 1 ? 'clinic' : 'clinics'}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 rounded-full bg-slate-200/80 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-teal-500"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: Interactive OPD Clinics Timeline */}
          <div className="xl:col-span-7 bg-white dark:bg-[#0f201c] p-5 rounded-2xl border border-slate-200/90 dark:border-emerald-500/20 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span>OPD Clinics Timeline</span>
                  {selectedSpecialty && (
                    <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold">
                      {selectedSpecialty}
                    </span>
                  )}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Showing {filteredItems.length} of {items.length} scheduled sessions
                </p>
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Filter doctor or clinic..."
                  className="pl-8 pr-3 py-1.5 rounded-xl border border-slate-200 dark:border-emerald-500/25 bg-slate-50 dark:bg-[#132822] text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>
            </div>

            {/* Time Axis Header */}
            <div className="relative h-6 border-b border-slate-200 dark:border-emerald-500/20 text-[10px] font-mono font-bold text-slate-500 dark:text-slate-400 select-none">
              {hourTicks.map(t => (
                <span
                  key={t.mins}
                  className="absolute -translate-x-1/2 top-0"
                  style={{ left: `${t.pct}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>

            <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1 custom-scrollbar">
              {groupedTimeline.map(group => (
                <div
                  key={group.specialty}
                  className="p-3 rounded-xl bg-slate-50/70 dark:bg-[#132822] border border-slate-200/70 dark:border-emerald-500/15 space-y-2"
                >
                  <div className="flex items-center justify-between text-xs font-extrabold text-slate-800 dark:text-slate-100">
                    <span className="flex items-center gap-1.5">
                      <Filter className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                      {group.specialty}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {group.sessions.length}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {group.sessions.map(s => {
                      const startM = parseTimeMinutes(s.startTime) ?? timelineBounds.minM;
                      const endM = Math.max(startM + 30, parseTimeMinutes(s.endTime) ?? startM + 60);
                      const leftPct = Math.max(0, ((startM - timelineBounds.minM) / timelineBounds.span) * 100);
                      const widthPct = Math.max(8, Math.min(100 - leftPct, ((endM - startM) / timelineBounds.span) * 100));
                      const docName = s.physicianAr || s.physicianEn;
                      return (
                        <div key={`${s.serial}-${docName}-${s.startTime}`} className="space-y-0.5">
                          <div className="flex items-center justify-between text-[11px] text-slate-700 dark:text-slate-200">
                            <span className="font-bold truncate">{docName}</span>
                            <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 shrink-0 ml-2">
                              {s.startTime} - {s.endTime}
                              {s.floorName ? ` · F:${s.floorName}` : ''}
                              {s.maxOccupancy > 0 ? ` · Cap:${s.maxOccupancy}` : ''}
                            </span>
                          </div>
                          <div className="relative h-3 rounded-md bg-slate-200/70 dark:bg-slate-800/80 overflow-hidden">
                            <div
                              className="absolute top-0 bottom-0 rounded-md bg-gradient-to-r from-emerald-600 to-teal-500"
                              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                              title={`${docName} (${s.startTime} - ${s.endTime})`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
