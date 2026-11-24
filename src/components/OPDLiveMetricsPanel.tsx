import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Ticket,
  Users,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { OPDLivePayload } from '../types';

interface OPDLiveMetricsPanelProps {
  onLiveLoaded?: (data: OPDLivePayload | null) => void;
}

function formatSyncTime(iso?: string | null): string {
  if (!iso) return 'Not synced';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export const OPDLiveMetricsPanel: React.FC<OPDLiveMetricsPanelProps> = ({ onLiveLoaded }) => {
  const [live, setLive] = useState<OPDLivePayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const loadLive = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch(force ? '/api/opd/live?refresh=1' : '/api/opd/live');
      if (res.ok) {
        const json = await res.json();
        const next = json?.data ?? null;
        setLive(next);
        onLiveLoaded?.(next);
      }
    } catch (err) {
      console.warn('Could not fetch live OPD volume:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadLive(false);
  }, []);

  const topSpecialties = useMemo(() => {
    return (live?.bySpecialty || []).slice(0, 8).map((s) => ({
      name: s.specialty.replace(/\s*Clinic$/i, '').slice(0, 20),
      fullName: s.specialty,
      Completed: s.completed,
      InClinic: s.inClinic,
      Waiting: s.waiting,
      Reserved: s.reserved,
    }));
  }, [live]);

  const busyPhysicians = useMemo(() => {
    return (live?.byPhysician || [])
      .filter((p) => p.waiting > 0 || p.inClinic > 0 || p.total >= 5)
      .slice(0, 8);
  }, [live]);

  if (loading) {
    return (
      <div className="p-5 rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 animate-pulse">
        <div className="h-5 w-48 bg-slate-200 dark:bg-[#142924] rounded mb-4" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-slate-100 dark:bg-[#142924]" />
          ))}
        </div>
      </div>
    );
  }

  if (!live?.summary) {
    return null;
  }

  const s = live.summary;

  return (
    <div className="p-5 rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-bold text-slate-900 dark:text-slate-50 flex items-center gap-2">
              <Activity className="w-4 h-4 text-brand-primary" />
              Live OPD Volume &amp; Confirmed Queue
            </h4>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-500/30">
              <Clock className="w-3 h-3" />
              Auto-Sync · {formatSyncTime(live.updatedAt)}
            </span>
            {live.isStale && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/50 dark:text-amber-300">
                <AlertTriangle className="w-3 h-3" />
                Stale
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Real-time visit funnel and confirmed queue depth synced from Power BI ({live.opdDate})
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadLive(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-50 dark:bg-[#142924] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-emerald-500/20 hover:bg-slate-100 cursor-pointer disabled:opacity-50"
          aria-label="Refresh live OPD volume"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh Live'}
        </button>
      </div>

      {/* Funnel KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#142924] border border-slate-200/70 dark:border-emerald-500/15">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Bookings</span>
            <Users className="w-3.5 h-3.5 text-slate-400" />
          </div>
          <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50 mt-1">
            {s.totalBookings}
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
            {s.reserved} reserved
          </div>
        </div>

        <div className="p-3 rounded-xl bg-amber-50/70 dark:bg-amber-950/25 border border-amber-200/80 dark:border-amber-500/25">
          <div className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 flex items-center justify-between">
            <span>Waiting Now</span>
            <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="text-xl font-bold tabular-nums text-amber-900 dark:text-amber-200 mt-1">
            {s.arrivedWaiting}
          </div>
          <div className="text-[10px] text-amber-700/90 dark:text-amber-300/80 tabular-nums">
            {s.confirmedQueueWaiting} in ticket queue
          </div>
        </div>

        <div className="p-3 rounded-xl bg-sky-50/70 dark:bg-sky-950/25 border border-sky-200/80 dark:border-sky-500/25">
          <div className="text-[11px] font-semibold text-sky-800 dark:text-sky-300 flex items-center justify-between">
            <span>In Clinic</span>
            <Activity className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
          </div>
          <div className="text-xl font-bold tabular-nums text-sky-900 dark:text-sky-200 mt-1">
            {s.inClinic}
          </div>
          <div className="text-[10px] text-sky-700/80 dark:text-sky-300/80">Active consults</div>
        </div>

        <div className="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/25 border border-emerald-200/80 dark:border-emerald-500/25">
          <div className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
            <span>Completed</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="text-xl font-bold tabular-nums text-emerald-900 dark:text-emerald-200 mt-1">
            {s.completed}
          </div>
          <div className="text-[10px] text-emerald-700/90 dark:text-emerald-300/80 tabular-nums">
            Show-up {s.showUpRatePct}%
          </div>
        </div>

        <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#142924] border border-slate-200/70 dark:border-emerald-500/15">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Cancelled</span>
            <XCircle className="w-3.5 h-3.5 text-rose-500" />
          </div>
          <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50 mt-1">
            {s.cancelled}
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400">Today</div>
        </div>

        <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#142924] border border-slate-200/70 dark:border-emerald-500/15">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex items-center justify-between">
            <span>Ticket Reqs</span>
            <Ticket className="w-3.5 h-3.5 text-brand-primary" />
          </div>
          <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50 mt-1">
            {s.pendingTicketRequests}
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400">Active requests</div>
        </div>
      </div>

      {/* Specialty Chart + Busiest Clinics */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {topSpecialties.length > 0 && (
          <div className="lg:col-span-3 p-4 rounded-xl bg-slate-50/70 dark:bg-[#142924]/70 border border-slate-200/70 dark:border-emerald-500/15">
            <div className="text-xs font-bold text-slate-800 dark:text-slate-100 mb-3">
              Top Specialties by Live Load
            </div>
            <div className="h-52 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topSpecialties} margin={{ top: 4, right: 10, left: -12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={46} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="Completed" stackId="opd" fill="#10b981" />
                  <Bar dataKey="InClinic" stackId="opd" fill="#0284c7" />
                  <Bar dataKey="Waiting" stackId="opd" fill="#d97706" />
                  <Bar dataKey="Reserved" stackId="opd" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        <div className="lg:col-span-2 p-4 rounded-xl bg-slate-50/70 dark:bg-[#142924]/70 border border-slate-200/70 dark:border-emerald-500/15 flex flex-col">
          <div className="text-xs font-bold text-slate-800 dark:text-slate-100 mb-3">
            Busiest Active Clinics Right Now
          </div>
          <div className="space-y-2.5 overflow-y-auto max-h-52 pr-1">
            {busyPhysicians.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">No active waiting queues right now.</p>
            ) : (
              busyPhysicians.map((doc, idx) => (
                <div
                  key={`${doc.physicianEn}-${idx}`}
                  className="p-2.5 rounded-lg bg-white dark:bg-[#0f201c] border border-slate-200/80 dark:border-emerald-500/15 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {doc.physicianEn}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                      {doc.specialty}
                      {doc.maxOccupancy ? ` · Cap ${doc.maxOccupancy}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 font-mono text-[11px] tabular-nums">
                    {doc.waiting > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 font-bold">
                        {doc.waiting} wait
                      </span>
                    )}
                    {doc.inClinic > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300 font-bold">
                        {doc.inClinic} in
                      </span>
                    )}
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#142924] text-slate-600 dark:text-slate-300">
                      {doc.completed}/{doc.total - doc.cancelled}
                    </span>
                    {doc.utilizationPct !== null && doc.utilizationPct !== undefined && (
                      <span
                        className={`px-1.5 py-0.5 rounded font-bold ${
                          doc.utilizationPct >= 90
                            ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300'
                            : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                        }`}
                      >
                        {doc.utilizationPct}%
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
