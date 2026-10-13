import React, { useState, useMemo } from 'react';
import {
  Clock,
  ChevronDown,
  ChevronUp,
  Calendar,
  AlertCircle,
  Building2,
  CheckCircle2,
  History,
  Activity,
  Layers
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
  CumulativeORData,
  useCumulativeORHistory
} from '../hooks/useCumulativeOccupancy';

interface CumulativeORPanelProps {
  data: CumulativeORData | null;
  loading: boolean;
  error: string | null;
}

export const CumulativeORPanel: React.FC<CumulativeORPanelProps> = ({
  data,
  loading,
  error
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'trend' | 'rooms' | 'history'>('trend');
  const { history, loading: historyLoading } = useCumulativeORHistory();

  const chartData = useMemo(() => {
    if (!data || !data.days || data.days.length === 0) return [];

    let runningBookedMins = 0;
    let runningAvailMins = 0;

    return data.days.map((d) => {
      const bookedHours = Math.round((d.bookedMinutes / 60) * 10) / 10;
      const roomsAvail = d.roomsAvailable || 7;
      const minPerRoom = d.minutesPerRoom || 1440;

      runningBookedMins += (d.bookedMinutes || 0);
      runningAvailMins += (roomsAvail * minPerRoom);

      const runningTimeUtil = runningAvailMins > 0
        ? Math.round((runningBookedMins / runningAvailMins) * 1000) / 10
        : 0;

      const dayNum = d.date.split('-')[2] || d.date;

      return {
        date: d.date,
        dayLabel: `Day ${parseInt(dayNum, 10)}`,
        bookedMinutes: d.bookedMinutes,
        bookedHours,
        roomsUsed: d.roomsUsed,
        casesTotal: d.casesTotal,
        runningTimeUtil,
        isProvisional: d.source === 'provisional',
        source: d.source,
      };
    });
  }, [data]);

  const fmtHours = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  };

  if (error) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800 flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 text-amber-600" />
        <span>Cumulative OR utilization notice: {error}</span>
      </div>
    );
  }

  return (
    <div className="bg-white/80 backdrop-blur-md rounded-2xl border border-white/40 shadow-xs overflow-hidden transition-all mt-4">
      {/* Header bar / Toggle */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="px-5 py-3.5 flex items-center justify-between cursor-pointer hover:bg-slate-50/80 transition select-none"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700 shadow-xs">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Operating Theatre Month-to-Date Utilization Analytics
              </span>
              {data?.includesProvisional && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
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
                  Time Utilization (24h basis): <strong className="text-indigo-700">{data.timeUtilization.toFixed(1)}%</strong> ({fmtHours(data.bookedMinutes)} booked) | Room Utilization: <strong className="text-purple-700">{data.roomUtilization.toFixed(1)}%</strong> | Cases: <strong className="text-slate-800">{data.casesTotal}</strong> (DC {data.dcCount} / HC {data.hcCount})
                </>
              ) : (
                'Loading cumulative OR metrics...'
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
                Daily Booked Hours Trend
              </button>
              <button
                onClick={() => setActiveTab('rooms')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                  activeTab === 'rooms'
                    ? 'bg-white text-slate-800 shadow-xs'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Room Breakdown (OR 1–7)
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
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Patient Type</span>
                  <span className="font-bold text-slate-800">IN: {data.inCount} / OUT: {data.outCount}</span>
                </div>
                <div className="bg-white px-3 py-1.5 rounded-xl border border-slate-200 shadow-2xs">
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Post-SICU</span>
                  <span className="font-bold text-rose-600">{data.sicuCount}</span>
                </div>
              </div>
            )}
          </div>

          {activeTab === 'trend' ? (
            <div>
              {chartData.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-xs">
                  <Calendar className="w-8 h-8 mb-2 opacity-50" />
                  No daily OR census records captured for this month yet.
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
                        yAxisId="left"
                        unit="h"
                        tick={{ fontSize: 11, fill: '#64748b' }}
                        stroke="#cbd5e1"
                      />
                      <YAxis
                        yAxisId="right"
                        orientation="right"
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
                                  Booked Time: <strong className="text-white">{p.bookedHours} hours ({p.bookedMinutes}m)</strong>
                                </div>
                                <div className="text-slate-300">
                                  Theatres Used: <strong className="text-white">{p.roomsUsed} / 7</strong> | Cases: <strong className="text-white">{p.casesTotal}</strong>
                                </div>
                                <div className="text-indigo-300 font-bold pt-1 border-t border-slate-800">
                                  Running Cumulative Time Util: {p.runningTimeUtil}%
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
                        yAxisId="left"
                        name="Daily Booked Theatres (Hours)"
                        dataKey="bookedHours"
                        radius={[6, 6, 0, 0]}
                        barSize={18}
                      >
                        {chartData.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={entry.isProvisional ? '#6366f1' : (entry.source === 'backfill' ? '#818cf8' : '#4f46e5')}
                            opacity={entry.isProvisional ? 0.85 : 0.9}
                          />
                        ))}
                      </Bar>
                      <Line
                        yAxisId="right"
                        name="Running Cumulative Time Util (%)"
                        type="monotone"
                        dataKey="runningTimeUtil"
                        stroke="#059669"
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: '#059669' }}
                        activeDot={{ r: 6 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                  <div className="flex items-center justify-center gap-6 mt-2 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-xs bg-[#4f46e5]" /> Booked Hours (Bars)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-1 bg-[#059669]" /> Running Time Utilization (Line)
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : activeTab === 'rooms' ? (
            <div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                {['OR-1', 'OR-2', 'OR-3', 'OR-4', 'OR-5', 'OR-6', 'OR-7'].map((roomName) => {
                  const stat = data?.roomBreakdown?.[roomName] || { minutes: 0, cases: 0 };
                  const isZero = stat.minutes === 0 && stat.cases === 0;

                  return (
                    <div
                      key={roomName}
                      className={`p-3.5 rounded-xl border text-center transition ${
                        isZero
                          ? 'bg-slate-50/60 border-slate-200/60 text-slate-400'
                          : 'bg-white border-indigo-200 shadow-2xs text-slate-800'
                      }`}
                    >
                      <div className="text-xs font-bold uppercase tracking-wider">{roomName}</div>
                      <div className="text-lg font-black mt-1 text-indigo-700">
                        {fmtHours(stat.minutes)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {stat.cases} {stat.cases === 1 ? 'case' : 'cases'} MTD
                      </div>
                      {isZero && (
                        <div className="text-[9px] uppercase font-bold text-slate-400 mt-1">Idle MTD</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              {history.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  No finalized historical OR months saved yet. Completed months will appear here locked automatically at the end of each month.
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400 uppercase text-[10px] font-bold">
                      <th className="py-2.5 px-3">Month</th>
                      <th className="py-2.5 px-3">Time Util (24h)</th>
                      <th className="py-2.5 px-3">Room Util</th>
                      <th className="py-2.5 px-3">Total Cases</th>
                      <th className="py-2.5 px-3">DC / HC</th>
                      <th className="py-2.5 px-3">IN / OUT</th>
                      <th className="py-2.5 px-3">Finalized At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {history.map((row: any) => (
                      <tr key={row.month} className="hover:bg-slate-50/80 transition font-medium">
                        <td className="py-2.5 px-3 font-bold text-slate-800">
                          {row.month ? String(row.month).slice(0, 7) : '—'}
                        </td>
                        <td className="py-2.5 px-3 font-bold text-indigo-700">
                          {row.time_utilization}%
                        </td>
                        <td className="py-2.5 px-3 text-purple-700 font-bold">
                          {row.room_utilization}%
                        </td>
                        <td className="py-2.5 px-3 text-slate-800 font-bold">
                          {row.cases_total}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {row.dc_count} / {row.hc_count}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {row.in_count} / {row.out_count}
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
