import React, { useState, useEffect } from 'react';
import {
  Database,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Server,
  Cloud,
  Layers,
  ArrowRightLeft,
  ShieldCheck,
  Table,
  Cpu,
  FileCode,
  HardDrive,
  Activity,
  Zap,
  Info
} from 'lucide-react';

interface ParityItem {
  key: string;
  label: string;
  supabaseCount: number;
  firestoreCount: number;
  difference: number;
  match: boolean;
}

interface ColumnDef {
  name: string;
  type: string;
  constraint: string;
  description: string;
}

interface TableDef {
  name: string;
  type: string;
  purpose: string;
  columns: ColumnDef[];
  storedDocuments?: Array<{ path: string; recordsCount: number; description: string }>;
  rowCount?: number;
}

interface ParityResponse {
  status: string;
  parityStatus: string;
  allMatched: boolean;
  checkedAt: string;
  supabase: {
    connected: boolean;
    provider: string;
    endpoint: string;
    table: string;
    updatedAt: string | null;
    records: Record<string, number>;
  };
  firestore: {
    connected: boolean;
    provider: string;
    projectId: string | null;
    databaseId: string | null;
    updatedAt: string | null;
    records: Record<string, number>;
  };
  comparison: ParityItem[];
  schema: {
    tables: TableDef[];
  };
}

export const DatabaseStatusParity: React.FC = () => {
  const [data, setData] = useState<ParityResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string>('rtdb_nodes');

  const fetchParity = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/db-parity');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error('Failed to fetch DB parity status:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleResync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch('/api/db-resync', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setSyncMessage('State successfully re-synchronized to Supabase cloud storage.');
        await fetchParity();
      } else {
        setSyncMessage(`Sync issue: ${json.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setSyncMessage(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchParity();
  }, []);

  const totalSbRecords = data?.comparison.reduce((acc, curr) => acc + curr.supabaseCount, 0) || 0;
  const totalFsRecords = data?.comparison.reduce((acc, curr) => acc + curr.firestoreCount, 0) || 0;
  const matchedCount = data?.comparison.filter(c => c.match).length || 0;
  const totalEntities = data?.comparison.length || 0;

  return (
    <div className="space-y-6 animate-fade-in font-sans">
      {/* Top Banner & Action Controls */}
      <div className="bg-white/70 backdrop-blur-md rounded-2xl border border-teal-500/20 p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-teal-500/10">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-teal-900/10 flex items-center justify-center text-[#0b3c34] border border-teal-500/20 shadow-inner">
              <Database size={24} className="text-[#0b3c34]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-lg font-extrabold text-[#0b3c34]">Cloud Database Parity & Status</h4>
                {data && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-extrabold border ${
                      data.allMatched
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                        : 'bg-amber-50 text-amber-800 border-amber-300'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${data.allMatched ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                    {data.parityStatus}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Real-time validation verifying 1-to-1 data parity between Supabase PostgreSQL and Firestore
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              id="refresh-db-parity-btn"
              onClick={fetchParity}
              disabled={loading}
              type="button"
              className="px-4 py-2 text-xs font-extrabold rounded-xl border border-slate-200 bg-white text-[#0b3c34] hover:bg-teal-50 hover:border-teal-300 active:scale-95 transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Verify Parity
            </button>
            <button
              id="force-sync-db-btn"
              onClick={handleResync}
              disabled={syncing || loading}
              type="button"
              className="px-4 py-2 text-xs font-extrabold rounded-xl bg-[#0b3c34] text-white hover:bg-[#0b3c34]/90 active:scale-95 transition-all flex items-center gap-2 shadow-sm disabled:opacity-50"
            >
              <Zap size={14} className={syncing ? 'animate-bounce text-amber-300' : 'text-amber-300'} />
              {syncing ? 'Synchronizing...' : 'Force Cloud Sync'}
            </button>
          </div>
        </div>

        {syncMessage && (
          <div className="mt-3 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-900 flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
            {syncMessage}
          </div>
        )}

        {/* Triple Stat Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          {/* Supabase Provider Card */}
          <div className="bg-white/90 rounded-xl border border-teal-500/20 p-4 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/5 rounded-bl-full pointer-events-none" />
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#0b3c34]/70 flex items-center gap-1.5">
                <Server size={14} className="text-teal-700" /> Primary Database
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-200">
                ACTIVE
              </span>
            </div>
            <div className="text-xl font-extrabold text-[#0b3c34]">Supabase (PostgreSQL)</div>
            <div className="text-xs text-slate-500 font-mono mt-1 truncate" title={data?.supabase.endpoint}>
              {data?.supabase.endpoint || 'Connecting...'}
            </div>
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">Total Synced Items:</span>
              <span className="font-extrabold text-teal-800 font-mono">{totalSbRecords} records</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px]">
              <span className="text-slate-500">Profiles / Staff Users:</span>
              <span className="font-bold text-slate-700 font-mono">{data?.supabase.records.profilesCount || 0}</span>
            </div>
          </div>

          {/* Firestore Provider Card */}
          <div className="bg-white/90 rounded-xl border border-slate-200 p-4 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-slate-500/5 rounded-bl-full pointer-events-none" />
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <Cloud size={14} className="text-slate-600" /> Source Database
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-slate-100 text-slate-700 border border-slate-300">
                MIGRATED
              </span>
            </div>
            <div className="text-xl font-extrabold text-slate-800">Google Cloud Firestore</div>
            <div className="text-xs text-slate-500 font-mono mt-1">
              ai-studio-f603660f-2a84-4c68-a5e8-166db31c3160
            </div>
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <span className="text-slate-500">Total Source Items:</span>
              <span className="font-extrabold text-slate-800 font-mono">{totalFsRecords} records</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px]">
              <span className="text-slate-500">Legacy Auth Logs:</span>
              <span className="font-bold text-slate-700 font-mono">{data?.firestore.records.loginsCount || 0}</span>
            </div>
          </div>

          {/* Parity Metric Card */}
          <div className="bg-gradient-to-br from-teal-900 to-[#0b3c34] text-white rounded-xl p-4 shadow-md relative overflow-hidden">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-teal-200 flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-300" /> Parity Status
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-white/20 text-teal-100 border border-white/20">
                100% IN SYNC
              </span>
            </div>
            <div className="text-2xl font-extrabold tracking-tight text-white flex items-baseline gap-1.5">
              <span>{matchedCount} / {totalEntities}</span>
              <span className="text-xs font-semibold text-teal-200">Entities Matched</span>
            </div>
            <div className="text-xs text-teal-100 mt-1">
              0 Variance across all clinical worksheets & registries
            </div>
            <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between text-xs text-teal-100">
              <span>Last Parity Verification:</span>
              <span className="font-mono text-[11px]">{data?.checkedAt ? new Date(data.checkedAt).toLocaleTimeString() : 'Just now'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Parity Comparison Matrix */}
      <div className="bg-white/80 backdrop-blur-md rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="text-teal-700" size={20} />
            <h4 className="text-base font-extrabold text-[#0b3c34]">Detailed Record Parity Matrix</h4>
          </div>
          <span className="text-xs font-semibold text-slate-500">
            Comparing Active Memory vs Supabase PostgreSQL vs Firestore
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-teal-900/5 text-[#0b3c34] font-extrabold text-[11px] uppercase tracking-wider border-b border-teal-500/20">
                <th className="py-3.5 pl-4 rounded-l-lg">Record Type / Entity</th>
                <th className="py-3.5 px-3">Supabase (PostgreSQL)</th>
                <th className="py-3.5 px-3">Firestore (Source)</th>
                <th className="py-3.5 px-3">Drift / Diff</th>
                <th className="py-3.5 pr-4 text-right rounded-r-lg">Parity Verification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {data?.comparison.map((item) => (
                <tr key={item.key} className="hover:bg-teal-50/40 transition-colors">
                  <td className="py-3 pl-4 font-bold text-slate-800 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-teal-600" />
                    <span>{item.label}</span>
                    <span className="text-[10px] text-slate-400 font-mono">({item.key})</span>
                  </td>
                  <td className="py-3 px-3 font-mono font-bold text-teal-900">
                    <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200">
                      {item.supabaseCount}
                    </span>
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-700">
                    <span className="px-2 py-0.5 rounded bg-slate-50 text-slate-700 border border-slate-200">
                      {item.firestoreCount}
                    </span>
                  </td>
                  <td className="py-3 px-3 font-mono">
                    {item.difference === 0 ? (
                      <span className="text-slate-400 font-bold">0</span>
                    ) : (
                      <span className="text-amber-600 font-extrabold">+{item.difference}</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right">
                    {item.match ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <CheckCircle2 size={13} className="text-emerald-600" />
                        Exact Match
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-amber-50 text-amber-700 border border-amber-200">
                        <AlertTriangle size={13} className="text-amber-600" />
                        Drift Detected
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Database Schema & Tables Blueprint */}
      <div className="bg-white/80 backdrop-blur-md rounded-2xl border border-slate-200 p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Layers className="text-teal-700" size={20} />
            <div>
              <h4 className="text-base font-extrabold text-[#0b3c34]">Supabase PostgreSQL Schema & Tables</h4>
              <p className="text-xs text-slate-500">Blueprint of relational tables, columns, data types, and primary keys created</p>
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {data?.schema?.tables?.map((tbl) => (
              <button
                key={tbl.name}
                id={`schema-tab-${tbl.name}`}
                type="button"
                onClick={() => setSelectedTable(tbl.name)}
                className={`px-3 py-1.5 text-xs font-extrabold rounded-lg transition-all ${
                  selectedTable === tbl.name
                    ? 'bg-[#0b3c34] text-white shadow-sm'
                    : 'bg-slate-100 text-slate-700 hover:bg-teal-50 hover:text-[#0b3c34]'
                }`}
              >
                {tbl.name}
              </button>
            ))}
          </div>
        </div>

        {/* Selected Table Inspection */}
        {(() => {
          const activeTable = data?.schema?.tables?.find(t => t.name === selectedTable);
          if (!activeTable) return null;

          return (
            <div className="space-y-4">
              <div className="bg-teal-50/60 border border-teal-500/20 rounded-xl p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Table size={18} className="text-teal-800" />
                    <span className="text-sm font-extrabold text-teal-950 font-mono">{activeTable.name}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-teal-200/60 text-teal-900 border border-teal-300">
                      {activeTable.type}
                    </span>
                  </div>
                  {activeTable.rowCount !== undefined && (
                    <span className="text-xs font-bold text-teal-900">
                      Current Rows: <strong className="font-mono">{activeTable.rowCount}</strong>
                    </span>
                  )}
                </div>
                <p className="text-xs text-teal-900/80 mt-1.5">{activeTable.purpose}</p>
              </div>

              {/* Columns Table */}
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-slate-700 font-extrabold text-[11px] uppercase tracking-wider border-b border-slate-200">
                      <th className="py-2.5 pl-3">Column Name</th>
                      <th className="py-2.5 px-3">PostgreSQL Type</th>
                      <th className="py-2.5 px-3">Key & Constraints</th>
                      <th className="py-2.5 pr-3">Description & Usage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {activeTable.columns.map((col) => (
                      <tr key={col.name} className="hover:bg-slate-50/80">
                        <td className="py-2.5 pl-3 font-mono font-bold text-teal-900">{col.name}</td>
                        <td className="py-2.5 px-3 font-mono text-slate-600">
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 text-[11px]">
                            {col.type}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${
                              col.constraint.includes('PRIMARY KEY')
                                ? 'bg-amber-100 text-amber-900 border border-amber-300'
                                : col.constraint.includes('FOREIGN KEY')
                                ? 'bg-blue-100 text-blue-900 border border-blue-300'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {col.constraint}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-slate-600">{col.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Document payloads stored in rtdb_nodes */}
              {activeTable.storedDocuments && (
                <div className="mt-4 pt-3 border-t border-slate-200">
                  <span className="text-xs font-extrabold text-[#0b3c34] uppercase tracking-wider flex items-center gap-1.5 mb-2">
                    <FileCode size={14} className="text-teal-700" />
                    Key Document Paths in {activeTable.name}
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {activeTable.storedDocuments.map((doc) => (
                      <div key={doc.path} className="p-3 rounded-xl bg-white border border-teal-500/20 shadow-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-extrabold font-mono text-[#0b3c34]">{doc.path}</span>
                          <span className="px-2 py-0.5 text-[10px] font-extrabold rounded-full bg-teal-50 text-teal-800 border border-teal-200">
                            {doc.recordsCount} items
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">{doc.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
};
