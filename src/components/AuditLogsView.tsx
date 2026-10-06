import React from 'react';
import { RefreshCw, Clock } from 'lucide-react';

export interface LoginAuditLog {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  timestamp: string;
}

export interface AuditLogsViewProps {
  loginLogs: LoginAuditLog[];
  loadingLogs: boolean;
  onRefreshLogs: () => void;
}

export function AuditLogsView({
  loginLogs,
  loadingLogs,
  onRefreshLogs,
}: AuditLogsViewProps) {
  return (
    <section className="space-y-6 animate-fade-in">
      <div>
        <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
          <h3 className="text-xl font-extrabold text-brand-primary tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">
            User Login Audit Logs
          </h3>
        </div>
      </div>

      <div className="bg-white/60 backdrop-blur-md rounded-2xl border border-white/20 p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
          <div>
            <h4 className="text-lg font-bold text-brand-primary">Active Authentication Logs</h4>
            <p className="text-xs text-slate-500">
              Tracks user authentication and access sessions secured through Google SSO (Limit: 100 entries)
            </p>
          </div>
          <button
            onClick={onRefreshLogs}
            disabled={loadingLogs}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-brand-primary hover:text-brand-primary/80 bg-white border border-slate-200 hover:border-slate-300 rounded-xl transition duration-150 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
            Refresh logs
          </button>
        </div>

        {loadingLogs && loginLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400">
            <RefreshCw className="w-8 h-8 animate-spin mb-3 text-teal-600" />
            <p className="text-sm">Loading audit logs...</p>
          </div>
        ) : loginLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
            <Clock className="w-8 h-8 mb-3 text-slate-300" />
            <p className="text-sm font-medium">No recent login records found</p>
            <p className="text-xs text-slate-400 mt-1">Activities will be tracked here dynamically</p>
          </div>
        ) : (
          <div className="overflow-y-auto max-h-[500px] border border-slate-100 rounded-xl custom-scrollbar">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="sticky top-0 bg-white/95 backdrop-blur z-10 shadow-[0_1px_0_0_rgba(226,232,240,1)]">
                <tr className="text-brand-primary/70 uppercase tracking-wider font-extrabold text-[10px]">
                  <th className="py-3 pl-4">User (Display Name)</th>
                  <th className="py-3">Email Address</th>
                  <th className="py-3">Session Date & Time</th>
                  <th className="py-3 text-right pr-4">Security ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loginLogs.map((log) => {
                  const localDate = new Date(log.timestamp).toLocaleString();
                  return (
                    <tr key={log.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="py-3.5 pl-4 font-semibold text-slate-800 flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-teal-50 text-teal-700 flex items-center justify-center text-[10px] font-extrabold shadow-sm shrink-0">
                          {log.displayName ? log.displayName.charAt(0).toUpperCase() : (log.email ? log.email.charAt(0).toUpperCase() : '?')}
                        </div>
                        <span className="truncate max-w-[160px]" title={log.displayName || 'Unnamed User'}>
                          {log.displayName || 'Unnamed User'}
                        </span>
                      </td>
                      <td className="py-3.5 text-slate-600 font-mono text-xs">{log.email}</td>
                      <td className="py-3.5 text-slate-500 font-medium">{localDate}</td>
                      <td className="py-3.5 text-right pr-4 font-mono text-[9px] text-slate-400 select-all">{log.id}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export default AuditLogsView;
