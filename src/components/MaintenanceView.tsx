import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Play,
  Pause,
  RotateCw,
  RefreshCw,
  Server,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Copy,
  Check,
  ShieldCheck,
  Laptop,
  Monitor,
} from 'lucide-react';

interface SyncLogEntry {
  id: number;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  runnerId: string;
  platform: string;
}

interface PendingDischargeStats {
  lastCheckedAt: string | null;
  totalDetected: number;
  addedCount: number;
  skippedDialysisCount: number;
  skippedErCount: number;
  skippedAlreadyDischargedCount: number;
  recentCases: string[];
}

interface RunnerInfo {
  runnerId: string;
  hostname: string;
  platform: 'mac' | 'windows' | 'linux';
  osLabel: string;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  onPremReachable: boolean;
  status: string;
  childPid: number | null;
  restartCount: number;
  lastCycleStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunEta: string | null;
  pendingDischarge: PendingDischargeStats;
}

interface MaintenanceStatusResponse {
  control: {
    paused: boolean;
    desiredState: 'running' | 'paused';
    maxRunners: number;
    runNowRequestId: number;
    restartRequestId: number;
    lastUserOpenedAt: string | null;
    updatedBy: string | null;
    updatedAt: string;
  };
  maxRunners: number;
  activeRunnersCount: number;
  runners: RunnerInfo[];
  lastDatabaseUpdatedAt: string | null;
  metadataCounts: Record<string, number> | null;
  logs: SyncLogEntry[];
  serverMode: string;
}

interface MaintenanceViewProps {
  userEmail: string;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso;
  const diffSec = Math.round((Date.now() - dt.getTime()) / 1000);
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m ago`;
}

export function MaintenanceView({ userEmail }: MaintenanceViewProps) {
  const [statusData, setStatusData] = useState<MaintenanceStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'warning' | 'error'>('all');
  const [copiedLogs, setCopiedLogs] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/maintenance/sync-status', {
        headers: { 'x-user-email': userEmail },
      });
      if (!res.ok) {
        throw new Error(`Status HTTP ${res.status}`);
      }
      const json = await res.json();
      setStatusData(json);
      setErrorMsg(null);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to load sync status');
    } finally {
      setLoading(false);
    }
  }, [userEmail]);

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 5000);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const sendControlAction = async (action: 'run-now' | 'restart' | 'pause' | 'resume') => {
    setActionLoading(action);
    try {
      const res = await fetch('/api/maintenance/sync-control', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-email': userEmail,
        },
        body: JSON.stringify({ action, email: userEmail }),
      });
      const json = await res.json();
      if (json?.status) {
        setStatusData(json.status);
      } else {
        await fetchStatus();
      }
    } catch (err: any) {
      setErrorMsg(err?.message || `Failed to execute ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  const isPaused = Boolean(statusData?.control?.paused);
  const runners = statusData?.runners || [];
  const onPremRunners = runners.filter((r) => r.onPremReachable);
  const macRunner = runners.find((r) => r.platform === 'mac');
  const winRunner = runners.find((r) => r.platform === 'windows');

  const latestPendingStats =
    runners.find((r) => r.pendingDischarge?.lastCheckedAt)?.pendingDischarge || null;

  const filteredLogs = (statusData?.logs || []).filter((l) =>
    logFilter === 'all' ? true : l.level === logFilter
  );

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${l.timestamp}] [${l.platform.toUpperCase()}] [${l.level.toUpperCase()}] ${l.message}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  };

  return (
    <section className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-l-4 border-teal-600 pl-4">
        <div>
          <h3 className="text-xl font-extrabold text-brand-primary tracking-tight uppercase font-sans">
            System Maintenance & Auto-Sync Supervisor
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Monitors `sync_powerbi_relational.py` across up to 2 on-premises runners (1 macOS + 1 Windows) & Cybernetics Nurse Portal Pending Discharges
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => sendControlAction('run-now')}
            disabled={actionLoading !== null}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-extrabold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 rounded-xl shadow-sm transition"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            {actionLoading === 'run-now' ? 'Triggering...' : 'Run Now'}
          </button>

          <button
            onClick={() => sendControlAction('restart')}
            disabled={actionLoading !== null}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-extrabold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 disabled:opacity-50 rounded-xl shadow-sm transition"
          >
            <RotateCw className={`w-3.5 h-3.5 ${actionLoading === 'restart' ? 'animate-spin' : ''}`} />
            Restart
          </button>

          {isPaused ? (
            <button
              onClick={() => sendControlAction('resume')}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-extrabold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-xl shadow-sm transition"
            >
              <Play className="w-3.5 h-3.5" />
              Resume Auto-Sync
            </button>
          ) : (
            <button
              onClick={() => sendControlAction('pause')}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-extrabold text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 disabled:opacity-50 rounded-xl shadow-sm transition"
            >
              <Pause className="w-3.5 h-3.5" />
              Pause
            </button>
          )}

          <button
            onClick={fetchStatus}
            disabled={loading}
            className="p-2 text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl shadow-sm transition"
            title="Refresh Status"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-xl text-xs font-semibold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Top KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Global State Card */}
        <div className="bg-white/70 backdrop-blur-md rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
              Global Sync State
            </span>
            <Activity className="w-4 h-4 text-teal-600" />
          </div>
          <div className="flex items-center gap-2.5">
            {isPaused ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-amber-100 text-amber-800">
                <Pause className="w-3.5 h-3.5" /> Paused by Admin
              </span>
            ) : onPremRunners.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800">
                <CheckCircle2 className="w-3.5 h-3.5" /> Auto-Run Active ({onPremRunners.length}/2 Online)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-extrabold bg-slate-100 text-slate-700">
                <Clock className="w-3.5 h-3.5" /> Waiting for On-Prem Runner (0/2)
              </span>
            )}
          </div>
          <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
            <div className="flex justify-between">
              <span>Last DB Commit:</span>
              <span className="font-bold text-slate-700">
                {formatRelativeTime(statusData?.lastDatabaseUpdatedAt)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Last App Open Signal:</span>
              <span className="font-semibold text-slate-600">
                {formatRelativeTime(statusData?.control?.lastUserOpenedAt)}
              </span>
            </div>
          </div>
        </div>

        {/* 2 Runners Slot Status (Mac + Windows) */}
        <div className="bg-white/70 backdrop-blur-md rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
              Dedicated Runners (Max 2)
            </span>
            <Server className="w-4 h-4 text-teal-600" />
          </div>
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-100">
              <div className="flex items-center gap-2">
                <Laptop className="w-4 h-4 text-slate-700" />
                <div>
                  <div className="font-extrabold text-slate-800">Runner #1 — macOS</div>
                  <div className="text-[10px] text-slate-500">
                    {macRunner ? `${macRunner.hostname} (PID ${macRunner.childPid || macRunner.pid})` : 'Offline'}
                  </div>
                </div>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${
                  macRunner?.onPremReachable
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {macRunner ? macRunner.status : 'offline'}
              </span>
            </div>

            <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-100">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-blue-600" />
                <div>
                  <div className="font-extrabold text-slate-800">Runner #2 — Windows</div>
                  <div className="text-[10px] text-slate-500">
                    {winRunner ? `${winRunner.hostname} (PID ${winRunner.childPid || winRunner.pid})` : 'Offline'}
                  </div>
                </div>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase ${
                  winRunner?.onPremReachable
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {winRunner ? winRunner.status : 'offline'}
              </span>
            </div>
          </div>
        </div>

        {/* HMIS Pending Discharge Card */}
        <div className="bg-white/70 backdrop-blur-md rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
              Nurse Portal Pending Discharges
            </span>
            <ShieldCheck className="w-4 h-4 text-teal-600" />
          </div>
          <div className="grid grid-cols-4 gap-2 text-center my-2">
            <div className="p-2 rounded-xl bg-slate-50">
              <div className="text-base font-extrabold text-slate-800">
                {latestPendingStats?.totalDetected ?? 0}
              </div>
              <div className="text-[10px] text-slate-500 font-semibold">Found</div>
            </div>
            <div className="p-2 rounded-xl bg-emerald-50">
              <div className="text-base font-extrabold text-emerald-700">
                {latestPendingStats?.addedCount ?? 0}
              </div>
              <div className="text-[10px] text-emerald-700 font-semibold">Discharged</div>
            </div>
            <div className="p-2 rounded-xl bg-amber-50">
              <div className="text-base font-extrabold text-amber-700">
                {latestPendingStats?.skippedDialysisCount ?? 0}
              </div>
              <div className="text-[10px] text-amber-700 font-semibold">Dialysis Ignored</div>
            </div>
            <div className="p-2 rounded-xl bg-rose-50">
              <div className="text-base font-extrabold text-rose-700">
                {latestPendingStats?.skippedErCount ?? 0}
              </div>
              <div className="text-[10px] text-rose-700 font-semibold">ER Ignored</div>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 mt-2 flex justify-between">
            <span>Last Checked:</span>
            <span className="font-bold text-slate-700">
              {formatRelativeTime(latestPendingStats?.lastCheckedAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Live Terminal Logs */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 bg-slate-950 border-b border-slate-800">
          <div className="flex items-center gap-2 text-slate-200 text-xs font-extrabold tracking-wide uppercase">
            <Terminal className="w-4 h-4 text-teal-400" />
            <span>Live `sync_powerbi_relational.py` Output Stream</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
              {filteredLogs.length} lines
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(['all', 'info', 'warning', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setLogFilter(lvl)}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold uppercase transition ${
                  logFilter === lvl
                    ? 'bg-teal-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl}
              </button>
            ))}
            <button
              onClick={handleCopyLogs}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-extrabold uppercase bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
            >
              {copiedLogs ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copiedLogs ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="p-4 max-h-[420px] overflow-y-auto font-mono text-xs space-y-1.5 custom-scrollbar">
          {filteredLogs.length === 0 ? (
            <div className="text-slate-500 py-8 text-center">
              No sync logs recorded yet. Start the Mac or Windows runner on-premises or click "Run Now".
            </div>
          ) : (
            filteredLogs.map((l) => (
              <div key={`${l.runnerId}-${l.id}`} className="flex items-start gap-2 leading-relaxed">
                <span className="text-slate-500 shrink-0 select-none">
                  {new Date(l.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={`px-1.5 py-0.2 rounded text-[10px] font-bold uppercase shrink-0 ${
                    l.platform === 'mac'
                      ? 'bg-slate-800 text-teal-300'
                      : 'bg-blue-950 text-blue-300'
                  }`}
                >
                  {l.platform}
                </span>
                <span
                  className={
                    l.level === 'error'
                      ? 'text-rose-400 font-semibold break-all'
                      : l.level === 'warning'
                      ? 'text-amber-300 break-all'
                      : l.message.includes('[HMIS Pending]')
                      ? 'text-emerald-300 font-semibold break-all'
                      : 'text-slate-200 break-all'
                  }
                >
                  {l.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
export default MaintenanceView;
