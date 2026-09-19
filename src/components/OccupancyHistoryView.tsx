import React, { useState, useEffect } from 'react';
import { 
  Calendar, 
  FileSpreadsheet, 
  Download, 
  RefreshCw, 
  Clock, 
  ShieldCheck, 
  Users, 
  ArrowRightLeft, 
  CreditCard, 
  Search, 
  CheckCircle2, 
  AlertCircle,
  Database,
  Camera,
  LogOut,
  Tag,
  Filter
} from 'lucide-react';

interface OccupancyHistoryViewProps {
  onNotify?: (msg: string) => void;
}

export const OccupancyHistoryView: React.FC<OccupancyHistoryViewProps> = ({ onNotify }) => {
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [loadingDates, setLoadingDates] = useState<boolean>(true);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);
  const [detailData, setDetailData] = useState<any>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [takingSnapshot, setTakingSnapshot] = useState<boolean>(false);
  const [cairoStatus, setCairoStatus] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'inpatients' | 'discharges' | 'transfers'>('inpatients');

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
      const res = await fetch('/api/history/occupancy/dates');
      if (res.ok) {
        const data = await res.json();
        const raw = data.dates || [];
        const available: string[] = raw.map((item: any) => typeof item === 'string' ? item : item.date).filter(Boolean);
        setDates(available);
        if (available.length > 0) {
          // Default to newest date if not already selected
          if (!selectedDate || !available.includes(selectedDate)) {
            setSelectedDate(available[0]);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch occupancy history dates:', err);
    } finally {
      setLoadingDates(false);
    }
  };

  const fetchDetail = async (dateStr: string) => {
    if (!dateStr) return;
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/history/occupancy/detail?date=${encodeURIComponent(dateStr)}`);
      if (res.ok) {
        const data = await res.json();
        setDetailData(data);
      } else {
        setDetailData(null);
      }
    } catch (err) {
      console.error('Failed to fetch occupancy detail for date:', dateStr, err);
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
      const res = await fetch('/api/history/occupancy/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        if (onNotify) onNotify(`Snapshot successfully archived for ${data.snapshot?.date || 'today'}`);
        await fetchDates();
        if (data.snapshot?.date) {
          setSelectedDate(data.snapshot.date);
        }
      } else {
        alert(data.error || 'Failed to capture snapshot.');
      }
    } catch (err: any) {
      alert('Error taking snapshot: ' + err.message);
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
      console.error('Download error:', err);
      alert(`Failed to download report: ${err.message}`);
    } finally {
      setDownloading(null);
    }
  };

  const filteredPatients = (detailData?.patients || []).filter((p: any) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.room && p.room.toLowerCase().includes(q)) ||
      (p.doctor && p.doctor.toLowerCase().includes(q)) ||
      (p.contractor && p.contractor.toLowerCase().includes(q)) ||
      (p.mrn && p.mrn.toLowerCase().includes(q)) ||
      (p.floor && p.floor.toLowerCase().includes(q))
    );
  });

  const dischargedList: any[] = detailData?.dischargedPatients || [];

  const filteredDischarges = dischargedList.filter((p: any) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.room && p.room.toLowerCase().includes(q)) ||
      (p.doctor && p.doctor.toLowerCase().includes(q)) ||
      (p.contractor && p.contractor.toLowerCase().includes(q))
    );
  });

  const transfersList: any[] = detailData?.transfers || [];

  const filteredTransfers = transfersList.filter((t: any) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      (t.name && t.name.toLowerCase().includes(q)) ||
      (t.originalRoom && t.originalRoom.toLowerCase().includes(q)) ||
      (t.currentRoom && t.currentRoom.toLowerCase().includes(q)) ||
      (t.physician && t.physician.toLowerCase().includes(q)) ||
      (t.contractor && t.contractor.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 animate-fade-in" id="occupancy-history-container">
      {/* Top Banner & Cairo Schedule Indicator */}
      <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-teal-500/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-teal-600/10 text-teal-800 flex items-center justify-center font-extrabold shadow-inner">
              <Calendar size={26} className="text-teal-700" />
            </div>
            <div>
              <h2 className="text-2xl font-extrabold text-[#0b3c34] tracking-tight">Occupancy History & Reference Archives</h2>
              <p className="text-xs text-slate-600 font-medium mt-0.5">
                Saved snapshots preserved by date at reset & daily auto-reset at 11:59 PM (Egyptian Time).
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              id="take-occupancy-snapshot-btn"
              onClick={handleTakeManualSnapshot}
              disabled={takingSnapshot}
              type="button"
              className="px-4 py-2.5 bg-[#0b3c34] hover:bg-[#0e4e43] active:scale-95 text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <Camera size={15} />
              {takingSnapshot ? 'Archiving Snapshot...' : 'Take Reference Snapshot Now'}
            </button>
            <button
              id="refresh-occupancy-history-btn"
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
              <div className="font-extrabold text-[#0b3c34]">Daily Auto-Reset Schedule</div>
              <div className="text-slate-600 text-[11px] mt-0.5">
                Everyday at <strong>11:59 PM</strong> (Egypt Time / Africa:Cairo). Automatically snapshots state before wipe.
              </div>
            </div>
          </div>

          <div className="bg-emerald-50/70 border border-emerald-200/60 rounded-xl p-3 flex items-start gap-2.5">
            <ShieldCheck size={16} className="text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <div className="font-extrabold text-emerald-950">Critical Data Persistence</div>
              <div className="text-slate-600 text-[11px] mt-0.5">
                VIP Cases & Discharged Cases (auto/manual) remain strictly persistent across all resets.
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

      {/* Date Selector and Download Action Hub */}
      <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label htmlFor="history-date-select" className="text-xs font-extrabold text-[#0b3c34] uppercase tracking-wider">
              Select Reference Date:
            </label>
            <div className="relative">
              <select
                id="history-date-select"
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

          {/* Quick Primary Download: Combined Sheet in Mohanad's Sheets */}
          {selectedDate && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                id="download-historical-refined-combined-btn"
                onClick={() => handleDownload(
                  `/api/reports/combined?refined=true&date=${encodeURIComponent(selectedDate)}`,
                  `Combined_Hospital_Refined_Report_${selectedDate}.xlsx`,
                  'Refined Combined Sheet'
                )}
                disabled={!!downloading || loadingDetail}
                type="button"
                className="px-5 py-3 bg-gradient-to-r from-teal-700 to-[#0b3c34] hover:from-teal-800 hover:to-[#082a24] active:scale-95 text-white text-xs md:text-sm font-extrabold rounded-xl shadow-lg shadow-teal-900/15 flex items-center gap-2.5 transition-all disabled:opacity-50"
              >
                <FileSpreadsheet size={18} />
                {downloading === 'Refined Combined Sheet' 
                  ? 'Generating Mohanad Combined Sheet...' 
                  : `Download Combined Sheet (Mohanad's Sheets) [${selectedDate}]`}
              </button>
            </div>
          )}
        </div>

        {/* Other Historical Reports Dropdown / Action Grid */}
        {selectedDate && (
          <div className="pt-4 border-t border-teal-500/10">
            <h4 className="text-xs font-extrabold text-[#0b3c34] uppercase tracking-wider mb-3">
              Individual Historical Sheets for {selectedDate}:
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <button
                onClick={() => handleDownload(
                  `/api/reports/combined?date=${encodeURIComponent(selectedDate)}`,
                  `Combined_Hospital_Report_${selectedDate}.xlsx`,
                  'Standard Combined'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">Standard Combined Sheet</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>

              <button
                onClick={() => handleDownload(
                  `/api/reports/occupancy_formatted?date=${encodeURIComponent(selectedDate)}`,
                  `Formatted_Occupancy_${selectedDate}.xlsx`,
                  'Formatted Occupancy'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">Formatted Occupancy Sheet</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>

              <button
                onClick={() => handleDownload(
                  `/api/reports/preview_occupancy_formatted?date=${encodeURIComponent(selectedDate)}`,
                  `Colored_Structured_Grid_Occupancy_${selectedDate}.xlsx`,
                  'Grid Occupancy'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">Refined Grid Occupancy Sheet</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>

              <button
                onClick={() => handleDownload(
                  `/api/reports/medical_director_combined?date=${encodeURIComponent(selectedDate)}`,
                  `Medical_Director_Combined_Report_${selectedDate}.xlsx`,
                  'Medical Director Combined'
                )}
                disabled={!!downloading}
                type="button"
                className="px-3.5 py-2.5 bg-white border border-teal-500/20 hover:border-teal-500/40 hover:bg-teal-50/50 rounded-xl text-left flex items-center justify-between text-xs font-bold text-[#0b3c34] transition-all shadow-sm"
              >
                <span className="truncate">Medical Director Combined Report</span>
                <Download size={14} className="text-teal-700 shrink-0 ml-2" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Snapshot Details and Metric Counters */}
      {selectedDate && (
        <div className="space-y-6">
          {loadingDetail ? (
            <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-12 text-center text-slate-500 text-sm font-bold flex flex-col items-center justify-center gap-3">
              <RefreshCw size={24} className="animate-spin text-teal-600" />
              Loading occupancy snapshot data for {selectedDate}...
            </div>
          ) : detailData ? (
            <>
              {/* Stat Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <div 
                  onClick={() => setActiveTab('inpatients')}
                  className={`cursor-pointer transition-all bg-white/80 backdrop-blur-md border ${
                    activeTab === 'inpatients' 
                      ? 'border-teal-600 ring-2 ring-teal-600/20 shadow-md' 
                      : 'border-teal-500/20 hover:border-teal-400 shadow-sm'
                  } rounded-xl p-4`}
                >
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Inpatients</div>
                  <div className="text-2xl font-black text-[#0b3c34] mt-1">{detailData.totalOccupancy || 0}</div>
                  <div className="text-[10px] text-teal-700 font-semibold mt-0.5">Active Occupancy</div>
                </div>

                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Entries</div>
                  <div className="text-2xl font-black text-emerald-700 mt-1">{detailData.entriesCount || 0}</div>
                  <div className="text-[10px] text-emerald-600 font-semibold mt-0.5">Recorded Admissions</div>
                </div>

                <div 
                  onClick={() => setActiveTab('discharges')}
                  className={`cursor-pointer transition-all bg-white/80 backdrop-blur-md border ${
                    activeTab === 'discharges' 
                      ? 'border-rose-600 ring-2 ring-rose-600/20 shadow-md' 
                      : 'border-teal-500/20 hover:border-rose-300 shadow-sm'
                  } rounded-xl p-4`}
                >
                  <div className="text-[11px] font-extrabold uppercase text-slate-500 flex items-center justify-between">
                    <span>Discharges</span>
                    <span className="text-[9px] font-bold px-1.5 py-0.2 rounded bg-rose-100 text-rose-800">
                      Persistent
                    </span>
                  </div>
                  <div className="text-2xl font-black text-rose-700 mt-1">{detailData.dischargesCount || dischargedList.length}</div>
                  <div className="text-[10px] text-rose-600 font-semibold mt-0.5">
                    Recorded Discharges
                  </div>
                </div>

                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Dialysis</div>
                  <div className="text-2xl font-black text-sky-700 mt-1">{detailData.dialysisCount || 0}</div>
                  <div className="text-[10px] text-sky-600 font-semibold mt-0.5">Sessions</div>
                </div>

                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Debts</div>
                  <div className="text-2xl font-black text-purple-700 mt-1">{detailData.debtsCount || 0}</div>
                  <div className="text-[10px] text-purple-600 font-semibold mt-0.5">Cash Overdues</div>
                </div>

                <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-xl p-4 shadow-sm">
                  <div className="text-[11px] font-extrabold uppercase text-slate-500">Transfers</div>
                  <div className="text-2xl font-black text-amber-700 mt-1">{detailData.transfersCount || 0}</div>
                  <div className="text-[10px] text-amber-600 font-semibold mt-0.5">Room Changes</div>
                </div>
              </div>

              {/* Patient Records Preview for the Historical Date */}
              <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-6 shadow-sm">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 border-b border-teal-500/10 pb-3">
                  {/* Tab Selector */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActiveTab('inpatients')}
                      type="button"
                      className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
                        activeTab === 'inpatients'
                          ? 'bg-[#0b3c34] text-white shadow-md'
                          : 'bg-teal-50 text-[#0b3c34] hover:bg-teal-100/70 border border-teal-500/20'
                      }`}
                    >
                      <Users size={15} />
                      Active Inpatients ({filteredPatients.length} / {detailData.totalOccupancy || 0})
                    </button>

                    <button
                      onClick={() => setActiveTab('discharges')}
                      type="button"
                      className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
                        activeTab === 'discharges'
                          ? 'bg-rose-700 text-white shadow-md'
                          : 'bg-rose-50 text-rose-800 hover:bg-rose-100/70 border border-rose-300/40'
                      }`}
                    >
                      <LogOut size={15} />
                      Discharged Cases ({filteredDischarges.length} / {dischargedList.length})
                    </button>

                    <button
                      onClick={() => setActiveTab('transfers')}
                      type="button"
                      className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
                        activeTab === 'transfers'
                          ? 'bg-amber-600 text-white shadow-md'
                          : 'bg-amber-50 text-amber-900 hover:bg-amber-100/70 border border-amber-300/40'
                      }`}
                    >
                      <ArrowRightLeft size={15} />
                      Transfers ({filteredTransfers.length} / {transfersList.length})
                    </button>
                  </div>

                  {/* Search and Filters */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative w-full sm:w-64">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input
                        type="text"
                        value={searchFilter}
                        onChange={(e) => setSearchFilter(e.target.value)}
                        placeholder="Filter by name, room, doctor..."
                        className="w-full text-xs pl-9 pr-3 py-2 border border-teal-500/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white/70 font-medium"
                      />
                    </div>
                  </div>
                </div>

                {/* Tab: Inpatients */}
                {activeTab === 'inpatients' && (
                  filteredPatients.length === 0 ? (
                    <div className="text-center py-10 text-slate-400 text-xs font-bold">
                      No matching inpatient records found in this snapshot.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-teal-500/10 rounded-xl max-h-[420px] overflow-y-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="sticky top-0 bg-[#0b3c34] text-white font-extrabold text-[11px] tracking-wide uppercase">
                          <tr>
                            <th className="py-2.5 px-3">#</th>
                            <th className="py-2.5 px-3">Room</th>
                            <th className="py-2.5 px-3">MRN</th>
                            <th className="py-2.5 px-3">Patient Name</th>
                            <th className="py-2.5 px-3">Physician</th>
                            <th className="py-2.5 px-3">Contractor</th>
                            <th className="py-2.5 px-3">Floor</th>
                            <th className="py-2.5 px-3">Category</th>
                            <th className="py-2.5 px-3">LOS</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#0b3c34]/5 bg-white/50 font-medium text-slate-700">
                          {filteredPatients.map((pt: any, idx: number) => (
                            <tr key={idx} className="hover:bg-teal-50/60 transition-colors">
                              <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                              <td className="py-2 px-3 font-bold text-teal-900 font-mono">{pt.room}</td>
                              <td className="py-2 px-3 text-slate-500 font-mono text-[11px]">{pt.mrn || '-'}</td>
                              <td className="py-2 px-3 font-bold text-[#0b3c34]">{pt.name}</td>
                              <td className="py-2 px-3 text-slate-600">{pt.doctor || '-'}</td>
                              <td className="py-2 px-3 text-slate-600">{pt.contractor || '-'}</td>
                              <td className="py-2 px-3 text-slate-500">{pt.floor || '-'}</td>
                              <td className="py-2 px-3 text-slate-500">{pt.category || '-'}</td>
                              <td className="py-2 px-3 text-slate-700 font-bold">{pt.los || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                )}

                {/* Tab: Discharges */}
                {activeTab === 'discharges' && (
                  filteredDischarges.length === 0 ? (
                    <div className="text-center py-10 text-slate-400 text-xs font-bold">
                      No matching discharged patient records found in this snapshot.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-rose-500/15 rounded-xl max-h-[420px] overflow-y-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="sticky top-0 bg-[#0b3c34] text-white font-extrabold text-[11px] tracking-wide uppercase">
                          <tr>
                            <th className="py-2.5 px-3">#</th>
                            <th className="py-2.5 px-3">Room</th>
                            <th className="py-2.5 px-3">Patient Name</th>
                            <th className="py-2.5 px-3">Physician</th>
                            <th className="py-2.5 px-3">Contractor</th>
                            <th className="py-2.5 px-3">Admission Date</th>
                            <th className="py-2.5 px-3">Discharge Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#0b3c34]/5 bg-white/50 font-medium text-slate-700">
                          {filteredDischarges.map((pt: any, idx: number) => {
                            return (
                              <tr key={idx} className="hover:bg-rose-50/50 transition-colors">
                                <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                                <td className="py-2 px-3 font-bold text-teal-900 font-mono">{pt.room || '-'}</td>
                                <td className="py-2 px-3 font-bold text-[#0b3c34]">
                                  <div className="flex items-center gap-2">
                                    <span>{pt.name}</span>
                                    {pt.isVip && (
                                      <span className="px-1.5 py-0.2 text-[9px] font-black rounded bg-amber-100 text-amber-900 border border-amber-300">
                                        VIP
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2 px-3 text-slate-600">{pt.doctor || '-'}</td>
                                <td className="py-2 px-3 text-slate-600">{pt.contractor || '-'}</td>
                                <td className="py-2 px-3 text-slate-500 font-mono text-[11px]">{pt.admissionDate || '-'}</td>
                                <td className="py-2 px-3 text-rose-700 font-mono text-[11px] font-bold">{pt.dischargeDate || '-'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                )}

                {/* Tab: Transfers */}
                {activeTab === 'transfers' && (
                  filteredTransfers.length === 0 ? (
                    <div className="text-center py-10 text-slate-400 text-xs font-bold">
                      No matching transfer records found in this snapshot.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-amber-500/20 rounded-xl max-h-[420px] overflow-y-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="sticky top-0 bg-[#0b3c34] text-white font-extrabold text-[11px] tracking-wide uppercase">
                          <tr>
                            <th className="py-2.5 px-3">#</th>
                            <th className="py-2.5 px-3">Patient Name</th>
                            <th className="py-2.5 px-3">From Room</th>
                            <th className="py-2.5 px-3">To Room</th>
                            <th className="py-2.5 px-3">Transfer Path</th>
                            <th className="py-2.5 px-3">Physician</th>
                            <th className="py-2.5 px-3">Contractor</th>
                            <th className="py-2.5 px-3">Date</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#0b3c34]/5 bg-white/50 font-medium text-slate-700">
                          {filteredTransfers.map((t: any, idx: number) => {
                            const steps = Array.isArray(t.steps) && t.steps.length > 0 ? t.steps : [];
                            return (
                              <tr key={idx} className="hover:bg-amber-50/50 transition-colors">
                                <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                                <td className="py-2 px-3 font-bold text-[#0b3c34]">{t.name}</td>
                                <td className="py-2 px-3 font-mono font-bold text-slate-600">{t.originalRoom || '-'}</td>
                                <td className="py-2 px-3 font-mono font-black text-amber-700">{t.currentRoom || '-'}</td>
                                <td className="py-2 px-3">
                                  {steps.length > 0 ? (
                                    <div className="flex items-center gap-1 flex-wrap">
                                      <span className="px-1.5 py-0.5 rounded bg-slate-100 font-mono text-[10px] text-slate-700 font-bold">{t.originalRoom}</span>
                                      {steps.map((s: any, sIdx: number) => (
                                        <React.Fragment key={sIdx}>
                                          <span className="text-amber-500 font-bold text-[10px]">→</span>
                                          <span className="px-1.5 py-0.5 rounded bg-amber-100 font-mono text-[10px] text-amber-900 font-bold">{s.toRoom}</span>
                                        </React.Fragment>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="font-mono text-slate-500 text-[11px]">{t.originalRoom} → {t.currentRoom}</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-slate-600">{t.physician || '-'}</td>
                                <td className="py-2 px-3 text-slate-600">{t.contractor || '-'}</td>
                                <td className="py-2 px-3 text-slate-500 font-mono text-[11px]">{t.date || '-'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
              </div>
            </>
          ) : (
            <div className="bg-white/80 backdrop-blur-md border border-teal-500/20 rounded-2xl p-8 text-center text-slate-500 text-xs font-bold">
              No detailed occupancy record found for {selectedDate}.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
