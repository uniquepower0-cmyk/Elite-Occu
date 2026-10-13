import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Calendar,
  AlertCircle,
  Clock,
  Building2,
  CheckCircle2,
  History
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell
} from 'recharts';
import {
  CumulativeBedData,
  useCumulativeBedHistory
} from '../hooks/useCumulativeOccupancy';

interface CumulativeOccupancyPanelProps {
  data: CumulativeBedData | null;
  loading: boolean;
  error: string | null;
}

export const CumulativeOccupancyPanel: React.FC<CumulativeOccupancyPanelProps> = ({
  data,
  loading,
  error
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'trend' | 'history'>('trend');
  const { history, loading: historyLoading } = useCumulativeBedHistory();

  // Compute daily chart points with running cumulative rate
  const chartData = useMemo(() => {
    if (!data || !data.days || data.days.length === 0) return [];

    let runningPtDays = 0;
    let runningBedDays = 0;

    return data.days.map((d) => {
      const dailyInpatientPct = d.inpatientCapacity > 0
        ? Math.round((d.inpatientOccupied / d.inpatientCapacity) * 1000) / 10
        : 0;
      
      runningPtDays += (d.inpatientOccupied || 0);
      runningBedDays += (d.inpatientCapacity || 0);

      const runningRate = runningBedDays > 0
        ? Math.round((runningPtDays / runningBedDays) * 1000) / 10
        : 0;

      const dayNum = d.date.split('-')[2] || d.date;

      return {
        date: d.date,
        dayLabel: `Day ${parseInt(dayNum, 10)}`,
        dailyOccupied: d.inpatientOccupied,
        dailyCapacity: d.inpatientCapacity,
        dailyRate: dailyInpatientPct,
        cumulativeRate: runningRate,
        isProvisional: d.source === 'provisional',
        source: d.source,
      };
    });
  }, [data]);

  if (error) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
        <span>Cumulative occupancy data notice: {error}</span>
      </div>
    );
  }

  return (
    <div className="bg-white/80 backdrop-blur-md rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden transition-all">
      {/* Header bar / Toggle */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="px-5 py-3.5 flex items-center justify-between cursor-pointer hover:bg-slate-50/80 transition select-none"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-700 shadow-xs">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Month-to-Date Cumulative Occupancy Analytics
              </span>
              {data?.includesProvisional && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live Provisional Today Included
                </span>
              )}
              {data?.isFinalized && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                  <CheckCircle2 className="w-3 h-3" />
                  Finalized Month
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {data ? (
                <>
                  Inpatient: <strong className="text-emerald-700">{data.inpatient.rate.toFixed(1)}%</strong> ({data.inpatient.patientDays.toLocaleString()} patient-days) | Total Hospital: <strong className="text-slate-700">{data.total.rate.toFixed(1)}%</strong> | {data.daysRecorded} of {data.daysInMonth} days recorded
                </>
              ) : (
                'Loading cumulative daily metrics...'
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">
            {isOpen ? 'Hide Panel' : 'Show Details & Trends'}
          </span>
          {isOpen ? (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </div>
      </div>

      {/* Expandable Content */}
      {isOpen && (
        <div className="border-t border-slate-200/80 p-5 bg-gradient-to-b from-slate-50/50 to-white">
          {/* Sub Navigation */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
              <button
                onClick={() => setActiveTab('trend')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  activeTab === 'trend'
                    ? 'bg-white text-slate-800 shadow-xs'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Current Month Daily Trend
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'history'
                    ? 'bg-white text-slate-800 shadow-xs'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                Past Months History ({history.length})
              </button>
            </div>

            {/* Quick KPI summary badges */}
            {data && (
              <div className="hidden sm:flex items-center gap-3 text-xs">
                <div className="bg-white px-3 py-1.5 rounded-xl border border-slate-200 shadow-2xs">
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Inpatient Bed-Days</span>
                  <span className="font-bold text-slate-800">{data.inpatient.patientDays} / {data.inpatient.bedDays}</span>
                </div>
                <div className="bg-white px-3 py-1.5 rounded-xl border border-slate-200 shadow-2xs">
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Missing Days</span>
                  <span className={`font-bold ${data.missingDays.length > 0 ? 'text-amber-600' : 'text-slate-800'}`}>
                    {data.missingDays.length}
                  </span>
                </div>
              </div>
            )}
          </div>

          {activeTab === 'trend' ? (
            <div>
              {chartData.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-xs">
                  <Calendar className="w-8 h-8 mb-2 opacity-50" />
                  No daily census records captured for this month yet.
                </div>
              ) : (
                <div className="w-full h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis
                        dataKey="dayLabel"
                        tick={{ fontSize: 11, fill: '#64748b' }}
                        stroke="#cbd5e1"
                      />
                      <YAxis
                        unit="%"
                        domain={[0, 100]}
                        tick={{ fontSize: 11, fill: '#64748b' }}
                        stroke="#cbd5e1"
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const p = payload[0].payload;
                            return (
                              <div className="bg-slate-900 text-white p-3 rounded-xl shadow-xl text-xs space-y-1 border border-slate-800">
                                <div className="font-bold border-b border-slate-700 pb-1 flex items-center justify-between gap-3">
                                  <span>{p.date}</span>
                                  {p.isProvisional && (
                                    <span className="text-amber-400 text-[10px] uppercase font-semibold">Provisional (Live)</span>
                                  )}
                                  {p.source === 'backfill' && (
                                    <span className="text-indigo-400 text-[10px] uppercase font-semibold">Backfilled</span>
                                  )}
                                </div>
                                <div className="text-slate-300">
                                  Daily Inpatient Occupied: <strong className="text-white">{p.dailyOccupied} / {p.dailyCapacity}</strong>
                                </div>
                                <div className="text-emerald-400 font-semibold">
                                  Daily Inpatient Rate: {p.dailyRate}%
                                </div>
                                <div className="text-indigo-300 font-bold pt-1 border-t border-slate-800">
                                  Running Cumulative MTD: {p.cumulativeRate}%
                                </div>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Legend
                        verticalAlign="top"
                        height={36}
                        formatter={(val) => <span className="text-xs font-semibold text-slate-700">{val}</span>}
                      />
                      <Bar
                        name="Daily Inpatient Rate (%)"
                        dataKey="dailyRate"
                        radius={[6, 6, 0, 0]}
                        barSize={18}
                      >
                        {chartData.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={entry.isProvisional ? '#0284c7' : (entry.source === 'backfill' ? '#818cf8' : '#059669')}
                            opacity={entry.isProvisional ? 0.85 : 0.9}
                          />
                        ))}
                      </Bar>
                      <Line
                        name="Running Cumulative MTD Rate (%)"
                        type="monotone"
                        dataKey="cumulativeRate"
                        stroke="#4f46e5"
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: '#4f46e5' }}
                        activeDot={{ r: 6 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                  <div className="flex items-center justify-center gap-6 mt-2 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-xs bg-[#059669]" /> Official Closed Day
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-xs bg-[#0284c7]" /> Today Provisional (Live)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-xs bg-[#818cf8]" /> Snapshot Backfill
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-1 bg-[#4f46e5]" /> Running MTD Rate
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              {history.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  No finalized historical months saved yet. Completed months will appear here locked automatically at the end of each month.
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase text-[10px] font-bold">
                      <th className="py-2.5 px-3">Month</th>
                      <th className="py-2.5 px-3">Inpatient Rate</th>
                      <th className="py-2.5 px-3">Total Hospital Rate</th>
                      <th className="py-2.5 px-3">Inpatient Pt-Days</th>
                      <th className="py-2.5 px-3">Days Recorded</th>
                      <th className="py-2.5 px-3">Finalized At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {history.map((row: any) => (
                      <tr key={row.month} className="hover:bg-slate-50/80 transition font-medium">
                        <td className="py-2.5 px-3 font-bold text-slate-800">
                          {row.month ? String(row.month).slice(0, 7) : '—'}
                        </td>
                        <td className="py-2.5 px-3 font-bold text-emerald-700">
                          {row.inpatient_rate}%
                        </td>
                        <td className="py-2.5 px-3 text-slate-700">
                          {row.total_rate}%
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {row.inpatient_patient_days} / {row.inpatient_bed_days}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {row.days_recorded} / {row.days_in_month}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                          {row.finalized_at ? new Date(row.finalized_at).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
