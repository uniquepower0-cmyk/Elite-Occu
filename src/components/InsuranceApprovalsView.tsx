import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock,
  FileCheck2,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCheck,
  X,
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
import type { ApprovalSeverity, InsuranceApprovalItem, InsuranceApprovalsPayload } from '../types';

interface InsuranceApprovalsViewProps {
  initialData?: InsuranceApprovalsPayload | null;
  onSelectPatientByMrn?: (mrn: string, room: string) => void;
  onDataLoaded?: (data: InsuranceApprovalsPayload | null) => void;
}

function formatSyncTime(iso?: string | null): string {
  if (!iso) return 'Not synced yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatApprovalStatusLabel(status: string): string {
  if (!status) return '—';
  if (status.toLowerCase().includes('needupdate')) return 'Need Update After Admission';
  if (status === 'ApprovalsForEverything') return 'Approvals For Everything';
  if (status === 'NoNeedForApprovalinPricelist') return 'No Approval Needed';
  return status;
}

export const InsuranceApprovalsView: React.FC<InsuranceApprovalsViewProps> = ({
  initialData = null,
  onSelectPatientByMrn,
  onDataLoaded,
}) => {
  const [payload, setPayload] = useState<InsuranceApprovalsPayload | null>(initialData);
  const [loading, setLoading] = useState<boolean>(!initialData);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<'all' | 'bottlenecks' | ApprovalSeverity>('bottlenecks');
  const [contractorFilter, setContractorFilter] = useState<string>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [groupTab, setGroupTab] = useState<'contractor' | 'agent'>('contractor');

  const loadApprovals = async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(forceRefresh ? '/api/approvals/data?refresh=1' : '/api/approvals/data');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const next = json?.data ?? null;
      setPayload(next);
      onDataLoaded?.(next);
    } catch (err: any) {
      setError(err?.message || 'Failed to load insurance approvals feed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (initialData) {
      setPayload(initialData);
      setLoading(false);
    } else {
      loadApprovals(false);
    }
  }, [initialData]);

  const filteredItems = useMemo(() => {
    const items = payload?.items || [];
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (severityFilter === 'bottlenecks' && item.severity === 'ok') return false;
      if (severityFilter !== 'all' && severityFilter !== 'bottlenecks' && item.severity !== severityFilter) {
        return false;
      }
      if (contractorFilter && item.contractor !== contractorFilter) return false;
      if (agentFilter && item.agentName !== agentFilter) return false;
      if (q) {
        const hay = `${item.patientName} ${item.mrn} ${item.room} ${item.contractor} ${item.physician} ${item.agentName} ${item.invoiceComment}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [payload, severityFilter, contractorFilter, agentFilter, searchQuery]);

  const chartData = useMemo(() => {
    const list = groupTab === 'contractor'
      ? (payload?.summary?.byContractor || [])
      : (payload?.summary?.byAgent || []);
    return list
      .filter((g) => g.rejected > 0 || g.pending > 0 || g.inProgress > 0 || g.bottlenecks > 0)
      .slice(0, 8)
      .map((g) => {
        const label = groupTab === 'contractor' ? (g.contractor || 'Unassigned') : (g.agent || 'Unassigned');
        return {
          name: label.length > 22 ? `${label.slice(0, 22)}…` : label,
          fullName: label,
          Rejected: g.rejected,
          Pending: g.pending,
          InProgress: g.inProgress,
        };
      });
  }, [payload, groupTab]);

  const summary = payload?.summary;

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200 dark:border-emerald-500/20">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50 tracking-tight">
              Insurance Approval Bottlenecks
            </h3>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-500/30">
              <Clock className="w-3 h-3" />
              On-Premises Auto-Sync · {formatSyncTime(payload?.updatedAt)}
            </span>
            {payload?.isStale && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-500/30">
                <AlertTriangle className="w-3 h-3" />
                Stale (&gt;90m)
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Live inpatient approval requests, rejections, and post-admission update blockers synced from Power BI
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadApprovals(true)}
          disabled={refreshing || loading}
          className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold bg-white dark:bg-[#142924] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-emerald-500/25 hover:bg-slate-50 dark:hover:bg-emerald-950/50 transition-colors cursor-pointer disabled:opacity-50"
          aria-label="Refresh insurance approvals data"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-500/30 text-rose-800 dark:text-rose-200 text-xs font-medium flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-24 rounded-xl bg-slate-100 dark:bg-[#142924] animate-pulse" />
          ))}
        </div>
      ) : !payload || !summary ? (
        <div className="p-10 rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 text-center">
          <ShieldAlert className="w-8 h-8 text-slate-400 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            No insurance approvals snapshot synced yet
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Data populates automatically from the on-premises hospital Python sync runner.
          </p>
        </div>
      ) : (
        <>
          {/* KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
                <span>Blocked Patients</span>
                <ShieldAlert className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums text-rose-700 dark:text-rose-400">
                  {summary.patientsWithBottlenecks}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  / {summary.totalPatients} tracked
                </span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
                <span>Rejected Requests</span>
                <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
                  {summary.totalRejected}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  of {summary.totalRequests} total
                </span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
                <span>Pending / In Progress</span>
                <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-400">
                  {summary.totalPending + summary.totalInProgress}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  ({summary.totalPending} pend · {summary.totalInProgress} active)
                </span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
                <span>Need Post-Admission Update</span>
                <FileCheck2 className="w-4 h-4 text-brand-primary" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
                  {summary.needUpdateCount}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  {summary.totalClosed} closed
                </span>
              </div>
            </div>
          </div>

          {/* Bottleneck Breakdown Chart & Filter Pills */}
          {chartData.length > 0 && (
            <div className="p-5 rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <div>
                  <h4 className="text-sm font-bold text-slate-900 dark:text-slate-50">
                    Bottlenecks by {groupTab === 'contractor' ? 'Insurance Contractor' : 'Approval Agent'}
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Click a pill below to filter the patient table
                  </p>
                </div>
                <div className="inline-flex rounded-lg p-0.5 bg-slate-100 dark:bg-[#142924] border border-slate-200 dark:border-emerald-500/20">
                  <button
                    type="button"
                    onClick={() => setGroupTab('contractor')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                      groupTab === 'contractor'
                        ? 'bg-white dark:bg-[#0f201c] text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <Building2 className="w-3.5 h-3.5" />
                    Contractors
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupTab('agent')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                      groupTab === 'agent'
                        ? 'bg-white dark:bg-[#0f201c] text-slate-900 dark:text-slate-50 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    Agents
                  </button>
                </div>
              </div>

              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 20, left: 10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="Rejected" stackId="a" fill="#e11d48" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="Pending" stackId="a" fill="#d97706" />
                    <Bar dataKey="InProgress" stackId="a" fill="#0284c7" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="flex flex-wrap gap-2 mt-4">
                {chartData.map((row) => {
                  const isActive = groupTab === 'contractor'
                    ? contractorFilter === row.fullName
                    : agentFilter === row.fullName;
                  return (
                    <button
                      key={row.fullName}
                      type="button"
                      onClick={() => {
                        if (groupTab === 'contractor') {
                          setContractorFilter(isActive ? '' : row.fullName);
                          setAgentFilter('');
                        } else {
                          setAgentFilter(isActive ? '' : row.fullName);
                          setContractorFilter('');
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-brand-primary text-white border-brand-primary'
                          : 'bg-slate-50 dark:bg-[#142924] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-emerald-500/20 hover:border-brand-primary/50'
                      }`}
                    >
                      <span>{row.fullName}</span>
                      <span className="font-mono text-[11px] opacity-80">
                        {row.Rejected > 0 ? `${row.Rejected} rej` : `${row.Pending + row.InProgress} open`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Filter Bar */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="w-4 h-4 text-slate-400" />
              {(
                [
                  { id: 'bottlenecks', label: `Bottlenecks (${summary.patientsWithBottlenecks})` },
                  { id: 'critical', label: 'Critical / Rejected' },
                  { id: 'warning', label: 'Pending / Active' },
                  { id: 'all', label: `All Patients (${summary.totalPatients})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSeverityFilter(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                    severityFilter === tab.id
                      ? 'bg-brand-primary text-white border-brand-primary'
                      : 'bg-white dark:bg-[#0f201c] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-emerald-500/20 hover:bg-slate-50'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
              {(contractorFilter || agentFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setContractorFilter('');
                    setAgentFilter('');
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-200/80 dark:bg-[#142924] text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                  Clear {contractorFilter || agentFilter}
                </button>
              )}
            </div>

            <div className="relative w-full md:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search patient, MRN, room, comment..."
                className="w-full pl-9 pr-3 py-2 rounded-lg text-xs bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              />
            </div>
          </div>

          {/* Patient Table */}
          <div className="rounded-2xl bg-white dark:bg-[#0f201c] border border-slate-200 dark:border-emerald-500/20 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-[#142924] border-b border-slate-200 dark:border-emerald-500/20 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4">Severity</th>
                    <th className="py-3 px-4">Room / Patient</th>
                    <th className="py-3 px-4">Contractor &amp; Agent</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Requests (Rej / Open / Done)</th>
                    <th className="py-3 px-4">Invoice Comment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-emerald-500/10 text-xs">
                  {filteredItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-slate-500 dark:text-slate-400">
                        No approval records match the active filter.
                      </td>
                    </tr>
                  ) : (
                    filteredItems.map((item: InsuranceApprovalItem, idx) => (
                      <tr
                        key={`${item.mrn || item.room}-${idx}`}
                        onClick={() => onSelectPatientByMrn?.(item.mrn, item.room)}
                        className={`hover:bg-slate-50/80 dark:hover:bg-[#142924]/70 transition-colors ${
                          onSelectPatientByMrn ? 'cursor-pointer' : ''
                        }`}
                      >
                        <td className="py-3 px-4 whitespace-nowrap">
                          {item.severity === 'critical' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 border border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-500/30 font-semibold">
                              <AlertCircle className="w-3 h-3" />
                              Critical
                            </span>
                          ) : item.severity === 'warning' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-500/30 font-semibold">
                              <AlertTriangle className="w-3 h-3" />
                              Pending
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 dark:bg-[#142924] dark:text-slate-300 dark:border-emerald-500/20 font-medium">
                              <CheckCircle2 className="w-3 h-3" />
                              Clear
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-[#142924] font-mono text-[11px] font-bold text-slate-700 dark:text-slate-200">
                              {item.room || '—'}
                            </span>
                            <span className="font-semibold text-slate-900 dark:text-slate-100">
                              {item.patientName || 'Unnamed'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                            MRN {item.mrn || '—'} · LOS {item.los}d{item.physician ? ` · Dr. ${item.physician}` : ''}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-slate-800 dark:text-slate-200">{item.contractor}</div>
                          {item.agentName && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                              Agent: {item.agentName}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-slate-700 dark:text-slate-300 font-medium">
                            {formatApprovalStatusLabel(item.status)}
                          </span>
                          {item.uploadedApprovals > 0 && (
                            <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5 tabular-nums">
                              {item.uploadedApprovals} uploaded
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap font-mono tabular-nums">
                          <span className={item.rejectedRequests > 0 ? 'text-rose-700 dark:text-rose-400 font-bold' : 'text-slate-400'}>
                            {item.rejectedRequests} rej
                          </span>
                          <span className="text-slate-300 dark:text-slate-600 mx-1">/</span>
                          <span className={item.pendingRequests + item.inProgressRequests > 0 ? 'text-amber-700 dark:text-amber-400 font-bold' : 'text-slate-400'}>
                            {item.pendingRequests + item.inProgressRequests} open
                          </span>
                          <span className="text-slate-300 dark:text-slate-600 mx-1">/</span>
                          <span className="text-slate-600 dark:text-slate-300">{item.closedRequests} done</span>
                        </td>
                        <td className="py-3 px-4 max-w-xs">
                          <p className="text-slate-600 dark:text-slate-300 line-clamp-2" title={item.invoiceComment}>
                            {item.invoiceComment || '—'}
                          </p>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
};
