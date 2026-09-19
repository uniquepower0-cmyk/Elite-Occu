import React, { useState, useEffect } from 'react';
import { 
  Calendar, 
  FileSpreadsheet, 
  Download, 
  RefreshCw, 
  Clock, 
  Activity, 
  CheckCircle2, 
  AlertCircle, 
  Search, 
  Camera,
  Database,
  Building2
} from 'lucide-react';

interface ORHistoryViewProps {
  onNotify?: (msg: string) => void;
}

export const ORHistoryView: React.FC<ORHistoryViewProps> = ({ onNotify }) => {
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [loadingDates, setLoadingDates] = useState<boolean>(true);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
  const [detailData, setDetailData] = useState<any>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [takingSnapshot, setTakingSnapshot] = useState<boolean>(false);
  const [cairoStatus, setCairoStatus] = useState<any>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/history/status');
      if (res.ok) {
        const data = await res.json();
        setCairoStatus(data);
      }
    } catch (e) {
      console.warn('Could not fetch Cairo status:', e);
    }
  };

  const fetchDates = async () => {
    setLoadingDates(true);
    try {
      const res = await fetch('/api/history/or/dates');
      if (res.ok) {
        const data = await res.json();
        const raw = data.dates || [];
        const available: string[] = raw.map((item: any) => typeof item === 'string' ? item : item.date).filter(Boolean);
        setDates(available);
        if (available.length > 0) {
          if (!selectedDate || !available.includes(selectedDate)) {
            setSelectedDate(available[0]);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch OR history dates:', err);
    } finally {
      setLoadingDates(false);
    }
  };

  const fetchDetail = async (dateStr: string) => {
    if (!dateStr) return;
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/history/or/detail?date=${encodeURIComponent(dateStr)}`);
      if (res.ok) {
        const data = await res.json();
        setDetailData(data);
      } else {
        setDetailData(null);
      }
    } catch (err) {
      console.error('Failed to fetch OR detail for date:', dateStr, err);
      setDetailData(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchDates();
  }, []);

  useEffect(() => {
    if (selectedDate) {
      fetchDetail(selectedDate);
    }
  }, [selectedDate]);

  const handleTakeManualSnapshot = async () => {
    setTakingSnapshot(true);
    try {
      const res = await fetch('/api/history/or/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        if (onNotify) onNotify(`OR snapshot successfully archived for ${data.snapshot?.date || 'today'}`);
        await fetchDates();
        if (data.snapshot?.date) {
          setSelectedDate(data.snapshot.date);
        }
      } else {
        alert(data.error || 'Failed to capture OR snapshot.');
      }
    } catch (err: any) {
      alert('Error taking OR snapshot: ' + err.message);
    } finally {
      setTakingSnapshot(false);
    }
  };

  const handleDownload = async (url: string, defaultFilename: string, label: string) => {
    setDownloading(label);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: 'Download failed' }));
        throw new Error(errJson.error || `Server returned ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition');
      let filename = defaultFilename;
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match && match[1]) filename = match[1];
      }
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (err: any) {
      console.error('OR Download error:', err);
      alert(`Failed to download report: ${err.message}`);
    } finally {
      setDownloading(null);
    }
  };

  const filteredCases = (detailData?.orList || []).filter((c: any) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      (c.patientName && c.patientName.toLowerCase().includes(q)) ||
      (c.surgeon && c.surgeon.toLowerCase().includes(q)) ||
      (c.operation && c.operation.toLowerCase().includes(q)) ||
      (c.orRoom && c.orRoom.toLowerCase().includes(q)) ||
      (c.mrn && String(c.mrn).toLowerCase().includes(q)) ||
      (c.room && c.room.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 animate-fade-in" id="or-history-container">
      {/* Top Banner */}
      <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-teal-500/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-teal-600/10 text-teal-800 flex items-center justify-center font-extrabold shadow-inner">
              <Activity size={26} className="text-teal-700" />
            </div>
            <div>
              <h2 className="text-2xl font-extrabold text-[#0b3c34] tracking-tight">OR Dashboard History & Archives</h2>
              <p className="text-xs text-slate-600 font-medium mt-0.5">
                Operating Room schedule and timeline reference snapshots saved by date.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              id="take-or-snapshot-btn"
              onClick={handleTakeManualSnapshot}
              disabled={takingSnapshot}
              type="button"
              className="px-4 py-2.5 bg-[#0b3c34] hover:bg-[#0e4e43] active:scale-95 text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <Camera size={15} />
              {takingSnapshot ? 'Archiving Snapshot...' : 'Take OR Reference Snapshot'}
            </button>
            <button
              id="refresh-or-history-btn"
              onClick={() => { fetchDates(); if (selectedDate) fetchDetail(selectedDate); }}
              type="button"
              className="p-2.5 rounded-xl border border-teal-500/20 hover:bg-teal-500/10 active:scale-95 text-teal-800 transition-all"
              title="Refresh Dates"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {/* Schedule & Persistence Notice */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-teal-50/70 border border-teal-200/60 rounded-xl p-3 flex items-start gap-2.5">
            <Clock size={16} className="text-teal-700 shrink-0 mt-0.5" />
            <div>
              <div className="font-extrabold text-[#0b3c34]">Daily Reset at 11:59 PM</div>
              <div className="text-slate-600 text-[11px] mt-0.5">
                Archived automatically everyday at 11:59 PM (Egypt Time) to preserve the historical audit record.
              </div>
            </div>
          </div>

          <div className="bg-emerald-50/70 border border-emerald-200/60 rounded-xl p-3 flex items-start gap-2.5">
            <Building2 size={16} className="text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <div className="font-extrabold text-emerald-950">Combined OR Workbook</div>
              <div className="text-slate-600 text-[11px] mt-0.5">
                Download Schedule, Timeline Graphics, Reconciliation & Over-listed cases formatted into one report.
              </div>
            </div>
          </div>

          <div className="bg-amber-50/70 border border-amber-200/60 rounded-xl p-3 flex items-start gap-2.5">
            <Database size={16} className="text-amber-800 shrink-0 mt-0.5" />
            <div>
              <div className="font-extrabold text-amber-950">Current Cairo Time</div>
              <div className="text-slate-700 text-[11px] mt-0.5 font-mono">
                {cairoStatus?.cairoTime || 'Loading time...'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Date Selector and Download Hub */}
      <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label htmlFor="or-history-date-select" className="text-xs font-extrabold text-[#0b3c34] uppercase tracking-wider">
              Select Reference Date:
            </label>
            <div className="relative">
              <select
                id="or-history-date-select"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                disabled={loadingDates || dates.length === 0}
                className="appearance-none bg-white border border-teal-500/30 text-[#0b3c34] font-bold text-sm rounded-xl py-2.5 pl-4 pr-10 shadow-sm focus:outline-none focus:ring-2 focus:ring-teal-500 min-w-[200px]"
              >
                {dates.length === 0 ? (
                  <option value="">No historical dates found</option>
                ) : (
                  dates.map((d) => (
                    <option key={d} value={d}>
                      {d} {d === cairoStatus?.cairoDate ? '(Today)' : ''}
                    </option>
                  ))
                )}
              </select>
              <Calendar size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-teal-600 pointer-events-none" />
            </div>

            {loadingDates && (
              <span className="text-xs text-slate-500 flex items-center gap-1.5 font-medium">
                <RefreshCw size={12} className="animate-spin text-teal-600" />
                Loading dates...
              </span>
            )}
          </div>

          {/* Primary Action: Download Combined OR Sheet */}
          {selectedDate && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                id="download-historical-or-combined-btn"
                onClick={() => handleDownload(
                  `/api/reports/or_combined?date=${encodeURIComponent(selectedDate)}`,
                  `Combined_OR_Refined_Report_${selectedDate}.xlsx`,
                  'Combined OR Sheet'
                )}
                disabled={!!downloading || loadingDetail}
                type="button"
                className="px-5 py-3 bg-gradient-to-r from-teal-700 to-[#0b3c34] hover:from-teal-800 hover:to-[#082a24] active:scale-95 text-white text-xs md:text-sm font-extrabold rounded-xl shadow-lg shadow-teal-900/15 flex items-center gap-2.5 transition-all disabled:opacity-50"
              >
                <FileSpreadsheet size={18} />
                {downloading === 'Combined OR Sheet' 
                  ? 'Generating Combined OR Workbook...' 
                  : `Download Combined OR Sheet (Refined Series) [${selectedDate}]`}
              </button>
            </div>
          )}
        </div>

        {/* Individual OR Reports */}
        {selectedDate && (
          <div className="pt-4 border-t border-teal-500/10">
            <h4 className="text-xs font-extrabold text-[#0b3c34] uppercase tracking-wider mb-3">
              Individual OR Reports for {selectedDate}:
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              <button
                onClick={() => handleDownload(
                  `/api/reports/or_list_refined?date=${encodeURIComponent(selectedDate)}`,
                  `Operating_Room_Schedule_Refined_${selectedDate}.xlsx`,
                  'OR Schedule'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">OR Schedule Refined</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>

              <button
                onClick={() => handleDownload(
                  `/api/reports/or_timeline_refined?date=${encodeURIComponent(selectedDate)}`,
                  `Operating_Room_Timeline_Graphics_${selectedDate}.xlsx`,
                  'OR Timeline'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">OR Timeline Graphics</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>

              <button
                onClick={() => handleDownload(
                  `/api/reports/or_reconciliation_refined?date=${encodeURIComponent(selectedDate)}`,
                  `Operating_Room_Reconciliation_Report_${selectedDate}.xlsx`,
                  'OR Reconciliation'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">OR Reconciliation Report</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>

              <button
                onClick={() => handleDownload(
                  `/api/reports/or_over_list_refined?date=${encodeURIComponent(selectedDate)}`,
                  `Over_Listed_OR_Cases_${selectedDate}.xlsx`,
                  'Over List'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">Over-Listed OR Cases</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Stats and Case List */}
      {selectedDate && (
        <div className="space-y-6">
          {loadingDetail ? (
            <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-12 text-center text-slate-500 text-sm font-bold flex flex-col items-center justify-center gap-3">
              <RefreshCw size={24} className="animate-spin text-teal-600" />
              Loading OR snapshot data for {selectedDate}...
            </div>
          ) : detailData ? (
            <>
              {/* Stat Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Total Surgical Cases</div>
                  <div className="text-2xl font-black text-[#0b3c34] mt-1">{detailData.totalCases || 0}</div>
                  <div className="text-[10px] text-teal-700 font-semibold mt-0.5">Scheduled OR Operations</div>
                </div>

                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Inpatients Matched (IN)</div>
                  <div className="text-2xl font-black text-emerald-700 mt-1">{detailData.matched || 0}</div>
                  <div className="text-[10px] text-emerald-600 font-semibold mt-0.5">Matched to Active Occupancy</div>
                </div>

                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Outpatients / Ambulatory (OUT)</div>
                  <div className="text-2xl font-black text-blue-700 mt-1">{detailData.outpatients || 0}</div>
                  <div className="text-[10px] text-blue-600 font-semibold mt-0.5">External / Day Surgery</div>
                </div>
              </div>

              {/* OR Cases Table Preview */}
              <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-6 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <Activity size={18} className="text-teal-700" />
                    <h3 className="text-base font-extrabold text-[#0b3c34]">
                      Historical OR Cases List ({filteredCases.length} of {detailData.totalCases || 0})
                    </h3>
                  </div>

                  <div className="relative w-full sm:w-72">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      placeholder="Filter surgeon, patient, procedure, room..."
                      className="w-full text-xs pl-9 pr-3 py-2 border border-teal-500/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white/70 font-medium"
                    />
                  </div>
                </div>

                {filteredCases.length === 0 ? (
                  <div className="text-center py-10 text-slate-400 text-xs font-bold">
                    No matching OR records found in this snapshot.
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-teal-500/10 rounded-xl max-h-[420px] overflow-y-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="sticky top-0 bg-[#0b3c34] text-white font-extrabold text-[11px] tracking-wide uppercase">
                        <tr>
                          <th className="py-2.5 px-3">#</th>
                          <th className="py-2.5 px-3">OR Room</th>
                          <th className="py-2.5 px-3">MRN</th>
                          <th className="py-2.5 px-3">Patient Name</th>
                          <th className="py-2.5 px-3">Surgeon</th>
                          <th className="py-2.5 px-3">Operation / Procedure</th>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-3">Hospital Bed</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#0b3c34]/5 bg-white/50 font-medium text-slate-700">
                        {filteredCases.map((c: any, idx: number) => (
                          <tr key={idx} className="hover:bg-teal-50/60 transition-colors">
                            <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                            <td className="py-2 px-3 font-bold text-teal-900 font-mono">{c.orRoom || '-'}</td>
                            <td className="py-2 px-3 text-slate-500 font-mono text-[11px]">{c.mrn || '-'}</td>
                            <td className="py-2 px-3 font-bold text-[#0b3c34]">{c.patientName || '-'}</td>
                            <td className="py-2 px-3 text-slate-600">{c.surgeon || '-'}</td>
                            <td className="py-2 px-3 text-slate-600 max-w-[200px] truncate" title={c.operation}>{c.operation || '-'}</td>
                            <td className="py-2 px-3">
                              <span className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold ${
                                c.realStatus === 'IN' 
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' 
                                  : 'bg-blue-100 text-blue-800 border border-blue-300'
                              }`}>
                                {c.realStatus || 'OUT'}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-slate-700 font-bold font-mono">{c.room || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-8 text-center text-slate-500 text-xs font-bold">
              No detailed OR record found for {selectedDate}.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
