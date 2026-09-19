import React, { useState, useMemo } from 'react';
import { 
  ArrowRightLeft, 
  Search, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Calendar, 
  History, 
  X,
  FileSpreadsheet,
  ArrowRight,
  Sparkles
} from 'lucide-react';
import { PatientTransferRecord } from '../types';

interface PatientTransfersTableProps {
  transfers: PatientTransferRecord[];
  onRefresh: () => Promise<void>;
  onDownloadExcel: () => Promise<void>;
  isDownloading?: boolean;
  activePatients?: any[];
}

export const PatientTransfersTable: React.FC<PatientTransfersTableProps> = ({
  transfers,
  onRefresh,
  onDownloadExcel,
  isDownloading = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingAction, setLoadingAction] = useState(false);
  
  // Add new transfer modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [patientName, setPatientName] = useState('');
  const [fromRoom, setFromRoom] = useState('');
  const [toRoom, setToRoom] = useState('');
  const [transferDate, setTransferDate] = useState('');
  const [physician, setPhysician] = useState('');
  const [contractor, setContractor] = useState('');
  const [notes, setNotes] = useState('');

  // Add next step to existing patient modal
  const [stepModalPatient, setStepModalPatient] = useState<PatientTransferRecord | null>(null);
  const [nextToRoom, setNextToRoom] = useState('');
  const [stepDate, setStepDate] = useState('');
  const [stepPhysician, setStepPhysician] = useState('');
  const [stepContractor, setStepContractor] = useState('');

  // Timeline history view modal
  const [historyPatient, setHistoryPatient] = useState<PatientTransferRecord | null>(null);

  // Filtered transfers
  const filteredTransfers = useMemo(() => {
    if (!searchQuery.trim()) return transfers;
    const q = searchQuery.toLowerCase().trim();
    return transfers.filter(t => {
      const nameMatch = (t.name || '').toLowerCase().includes(q);
      const currRoomMatch = (t.currentRoom || '').toLowerCase().includes(q);
      const initRoomMatch = (t.initialRoom || '').toLowerCase().includes(q);
      const journeyMatch = (t.journey || []).some(j => j.toLowerCase().includes(q));
      const docMatch = (t.physician || '').toLowerCase().includes(q);
      const contMatch = (t.contractor || '').toLowerCase().includes(q);
      return nameMatch || currRoomMatch || initRoomMatch || journeyMatch || docMatch || contMatch;
    });
  }, [transfers, searchQuery]);

  // Statistics
  const stats = useMemo(() => {
    const totalPatients = transfers.length;
    let totalEvents = 0;
    let multiTransfers = 0;
    transfers.forEach(t => {
      const journeyLen = Array.isArray(t.journey) ? t.journey.length : 2;
      const historyLen = Array.isArray(t.history) ? t.history.length : 1;
      const count = Math.max(historyLen, journeyLen - 1, 1);
      totalEvents += count;
      if (journeyLen > 2 || historyLen > 1) {
        multiTransfers++;
      }
    });
    return { totalPatients, totalEvents, multiTransfers };
  }, [transfers]);

  // Handle submit new transfer
  const handleCreateTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientName.trim() || !fromRoom.trim() || !toRoom.trim()) {
      alert('Please enter patient name, previous room, and new destination room.');
      return;
    }

    setLoadingAction(true);
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: patientName.trim(),
          fromRoom: fromRoom.trim(),
          toRoom: toRoom.trim(),
          date: transferDate.trim() || undefined,
          physician: physician.trim() || undefined,
          contractor: contractor.trim() || undefined,
          notes: notes.trim() || undefined
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save transfer record');
      }

      setIsAddModalOpen(false);
      setPatientName('');
      setFromRoom('');
      setToRoom('');
      setTransferDate('');
      setPhysician('');
      setContractor('');
      setNotes('');
      await onRefresh();
    } catch (err: any) {
      alert('Error saving transfer: ' + err.message);
    } finally {
      setLoadingAction(false);
    }
  };

  // Handle submit next step for patient
  const handleAddNextStep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stepModalPatient || !nextToRoom.trim()) {
      alert('Please enter the new destination room.');
      return;
    }

    setLoadingAction(true);
    try {
      const res = await fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: stepModalPatient.name,
          fromRoom: stepModalPatient.currentRoom,
          toRoom: nextToRoom.trim(),
          date: stepDate.trim() || undefined,
          physician: stepPhysician.trim() || stepModalPatient.physician,
          contractor: stepContractor.trim() || stepModalPatient.contractor
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to add next transfer step');
      }

      setStepModalPatient(null);
      setNextToRoom('');
      setStepDate('');
      setStepPhysician('');
      setStepContractor('');
      await onRefresh();
    } catch (err: any) {
      alert('Error adding transfer step: ' + err.message);
    } finally {
      setLoadingAction(false);
    }
  };

  // Handle delete transfer
  const handleDeleteTransfer = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete the transfer record for "${name}"?`)) {
      return;
    }

    setLoadingAction(true);
    try {
      const res = await fetch(`/api/transfers/${id}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        throw new Error('Failed to delete transfer record');
      }
      await onRefresh();
    } catch (err: any) {
      alert('Error deleting record: ' + err.message);
    } finally {
      setLoadingAction(false);
    }
  };

  // Handle clean duplicates
  const handleCleanDuplicates = async () => {
    setLoadingAction(true);
    try {
      const res = await fetch('/api/transfers/cleanup', {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error('Failed to sanitize transfers');
      }
      await onRefresh();
    } catch (err: any) {
      alert('Error cleaning duplicates: ' + err.message);
    } finally {
      setLoadingAction(false);
    }
  };

  // Handle auto-detect and sync transfers from latest occupancy and historical baselines
  const handleSyncFromOccupancy = async () => {
    setLoadingAction(true);
    try {
      const res = await fetch('/api/transfers/sync-from-occupancy', {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to detect transfers');
      }
      await onRefresh();
      alert(data.message || `Transfers reconciled. Total cases: ${data.transfersCount || 0}`);
    } catch (err: any) {
      alert('Error detecting transfers: ' + err.message);
    } finally {
      setLoadingAction(false);
    }
  };

  return (
    <div className="space-y-6 text-left" dir="ltr" id="patient-transfers-section">
      {/* Header Info Banner */}
      <div className="bg-gradient-to-r from-[#0b3c34] to-[#12584d] rounded-2xl p-6 text-white shadow-lg relative overflow-hidden">
        <div className="absolute right-0 top-0 w-96 h-96 bg-white/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-teal-200 text-xs font-semibold mb-2 backdrop-blur-sm">
              <ArrowRightLeft size={14} className="text-teal-300" />
              Cumulative Patient Transfers Registry
            </div>
            <h2 className="text-2xl font-black tracking-tight text-white">
              Patient Transfers Record
            </h2>
            <p className="text-teal-100/80 text-sm mt-1 max-w-2xl">
              Track cumulative patient room reassignments and department transfers across occupancy updates, documenting sequential journeys and treating physicians.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              id="btn-sync-occupancy-transfers"
              onClick={handleSyncFromOccupancy}
              disabled={loadingAction}
              type="button"
              className="px-3.5 py-2.5 bg-amber-500/80 hover:bg-amber-500 text-amber-950 font-bold rounded-xl text-xs flex items-center gap-1.5 border border-amber-300/40 shadow-sm transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
              title="Detect and reconcile transfers by comparing current occupancy against baseline snapshots"
            >
              <ArrowRightLeft size={14} className={loadingAction ? 'animate-spin' : ''} />
              Detect Transfers
            </button>
            <button
              id="btn-clean-transfers"
              onClick={handleCleanDuplicates}
              disabled={loadingAction}
              type="button"
              className="px-3.5 py-2.5 bg-emerald-600/60 hover:bg-emerald-600 text-teal-100 hover:text-white rounded-xl text-xs font-bold flex items-center gap-1.5 border border-emerald-400/30 shadow-sm transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
              title="Remove duplicate steps and sanitize room paths"
            >
              <Sparkles size={14} className="text-amber-300" />
              Clean Duplicates
            </button>
            <button
              id="btn-add-transfer"
              onClick={() => setIsAddModalOpen(true)}
              type="button"
              className="px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-sm font-bold flex items-center gap-2 shadow-md transition-all active:scale-95 cursor-pointer"
            >
              <Plus size={16} />
              Add Transfer
            </button>
            <button
              id="btn-download-transfers-excel"
              onClick={onDownloadExcel}
              disabled={isDownloading}
              type="button"
              className="px-4 py-2.5 bg-white text-[#0b3c34] hover:bg-teal-50 rounded-xl text-sm font-bold flex items-center gap-2 shadow-md transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
            >
              <FileSpreadsheet size={16} className="text-emerald-700" />
              {isDownloading ? 'Downloading...' : 'Download Excel Report'}
            </button>
            <button
              id="btn-refresh-transfers"
              onClick={onRefresh}
              disabled={loadingAction}
              type="button"
              className="p-2.5 bg-white/10 hover:bg-white/20 text-white rounded-xl transition-all cursor-pointer"
              title="Refresh Transfers Data"
            >
              <RefreshCw size={18} className={loadingAction ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Metrics Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6 pt-6 border-t border-white/10">
          <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 border border-white/10">
            <div className="text-xs text-teal-200 font-medium">Total Transferred Patients</div>
            <div className="text-2xl font-black mt-1 text-white">{stats.totalPatients}</div>
            <div className="text-[11px] text-teal-200/70 mt-0.5">Patients with recorded room moves</div>
          </div>
          <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 border border-white/10">
            <div className="text-xs text-teal-200 font-medium">Total Transfer Events</div>
            <div className="text-2xl font-black mt-1 text-emerald-300">{stats.totalEvents}</div>
            <div className="text-[11px] text-teal-200/70 mt-0.5">Sequential room transitions</div>
          </div>
          <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 border border-white/10">
            <div className="text-xs text-teal-200 font-medium">Multi-Step Transfers</div>
            <div className="text-2xl font-black mt-1 text-amber-300">{stats.multiTransfers}</div>
            <div className="text-[11px] text-teal-200/70 mt-0.5">Moved through 3+ locations (e.g. Khadija Jaber)</div>
          </div>
        </div>
      </div>

      {/* Search and Filters Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white/80 backdrop-blur-md p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="relative w-full sm:w-96">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            id="search-transfers-input"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by patient, room, physician, or contractor..."
            className="w-full pl-10 pr-10 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="text-xs font-semibold text-slate-500 self-start sm:self-center">
          Showing <span className="text-[#0b3c34] font-bold">{filteredTransfers.length}</span> of <span className="font-bold">{transfers.length}</span> records
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse" dir="ltr">
            <thead>
              <tr className="bg-[#0b3c34] text-white text-xs font-bold select-none">
                <th className="py-3 px-4 text-center w-12 border-b border-teal-800">#</th>
                <th className="py-3 px-4 border-b border-teal-800">Patient Name</th>
                <th className="py-3 px-4 border-b border-teal-800 text-center">Transfer Journey</th>
                <th className="py-3 px-4 border-b border-teal-800 text-center">Previous Room</th>
                <th className="py-3 px-4 border-b border-teal-800 text-center">Current Room</th>
                <th className="py-3 px-4 border-b border-teal-800 text-center">Transfer Date</th>
                <th className="py-3 px-4 border-b border-teal-800">Treating Physician</th>
                <th className="py-3 px-4 border-b border-teal-800">Contractor / Payer</th>
                <th className="py-3 px-4 border-b border-teal-800 text-center w-28">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTransfers.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    <ArrowRightLeft className="mx-auto text-slate-300 mb-2" size={36} />
                    <p className="font-semibold text-base">No matching transfer records found</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {searchQuery 
                        ? 'Try searching with different terms or clear the filter.' 
                        : 'Transfers will be recorded automatically when occupancy sheets update, or you can record them manually.'}
                    </p>
                  </td>
                </tr>
              ) : (
                filteredTransfers.map((item, idx) => {
                  const journey = Array.isArray(item.journey) && item.journey.length > 0
                    ? item.journey
                    : [item.initialRoom || '-', item.currentRoom || '-'];
                  
                  const isMultiHop = journey.length > 2;

                  return (
                    <tr 
                      key={item.id || idx}
                      className="hover:bg-teal-50/40 transition-colors group"
                    >
                      <td className="py-3 px-4 text-center text-xs font-mono text-slate-400">
                        {idx + 1}
                      </td>
                      
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900 flex items-center gap-2">
                          <span>{item.name}</span>
                          {isMultiHop && (
                            <span className="px-2 py-0.5 text-[10px] font-extrabold rounded-full bg-amber-100 text-amber-800 border border-amber-200 shrink-0">
                              Multi-Transfer ({journey.length - 1})
                            </span>
                          )}
                        </div>
                        {item.notes && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Note: {item.notes}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-4 text-center">
                        <div className="inline-flex items-center justify-center flex-wrap gap-1.5 py-1 px-2.5 bg-slate-50 border border-slate-200/80 rounded-xl" dir="ltr">
                          {journey.map((room, roomIdx) => {
                            const isLast = roomIdx === journey.length - 1;
                            const isFirst = roomIdx === 0;
                            return (
                              <React.Fragment key={roomIdx}>
                                <span
                                  className={`px-2 py-0.5 text-xs font-bold rounded-md transition-all ${
                                    isLast
                                      ? 'bg-emerald-600 text-white shadow-sm'
                                      : isFirst
                                      ? 'bg-slate-200 text-slate-700'
                                      : 'bg-teal-100 text-teal-900 border border-teal-200'
                                  }`}
                                >
                                  {room}
                                </span>
                                {!isLast && (
                                  <ArrowRight size={13} className="text-slate-400 shrink-0" />
                                )}
                              </React.Fragment>
                            );
                          })}
                        </div>
                      </td>

                      <td className="py-3 px-4 text-center font-mono text-slate-600 text-xs">
                        {item.history && item.history.length > 0 
                          ? item.history[item.history.length - 1].fromRoom 
                          : (item.initialRoom || '-')}
                      </td>

                      <td className="py-3 px-4 text-center">
                        <span className="px-2.5 py-1 text-xs font-extrabold rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 inline-block font-mono">
                          {item.currentRoom || '-'}
                        </span>
                      </td>

                      <td className="py-3 px-4 text-center text-xs text-slate-600">
                        <div className="inline-flex items-center gap-1">
                          <Calendar size={12} className="text-slate-400" />
                          <span>{item.lastTransferDate || '-'}</span>
                        </div>
                      </td>

                      <td className="py-3 px-4 text-xs text-slate-700 font-medium">
                        {item.physician || '-'}
                      </td>

                      <td className="py-3 px-4 text-xs text-slate-600">
                        {item.contractor || '-'}
                      </td>

                      <td className="py-3 px-4 text-center">
                        <div className="inline-flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => {
                              setStepModalPatient(item);
                              setNextToRoom('');
                              setStepDate('');
                              setStepPhysician(item.physician || '');
                              setStepContractor(item.contractor || '');
                            }}
                            title="Add next transfer destination for this patient"
                            type="button"
                            className="p-1.5 bg-teal-50 hover:bg-teal-100 text-[#0b3c34] rounded-lg transition-all cursor-pointer"
                          >
                            <Plus size={14} />
                          </button>
                          
                          <button
                            onClick={() => setHistoryPatient(item)}
                            title="View chronological transfer timeline"
                            type="button"
                            className="p-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-all cursor-pointer"
                          >
                            <History size={14} />
                          </button>

                          <button
                            onClick={() => handleDeleteTransfer(item.id, item.name)}
                            title="Delete transfer record"
                            type="button"
                            className="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg transition-all cursor-pointer"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal: Add New Patient Transfer */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" dir="ltr">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-slate-200 overflow-hidden text-left">
            <div className="px-6 py-4 bg-[#0b3c34] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowRightLeft size={18} className="text-teal-300" />
                <h3 className="font-bold text-base">Record New Patient Transfer</h3>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="text-teal-200 hover:text-white cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateTransfer} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Patient Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={patientName}
                  onChange={(e) => setPatientName(e.target.value)}
                  placeholder="e.g. Khadija Mohamed Ahmed Jaber"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Previous Room (From) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={fromRoom}
                    onChange={(e) => setFromRoom(e.target.value)}
                    placeholder="e.g. 309"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    New Destination Room (To) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={toRoom}
                    onChange={(e) => setToRoom(e.target.value)}
                    placeholder="e.g. Cath Lab or PICU Room 2"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Transfer Date & Time
                  </label>
                  <input
                    type="text"
                    value={transferDate}
                    onChange={(e) => setTransferDate(e.target.value)}
                    placeholder="Auto-assigned if empty"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Treating Physician
                  </label>
                  <input
                    type="text"
                    value={physician}
                    onChange={(e) => setPhysician(e.target.value)}
                    placeholder="Doctor's name"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Contractor / Payer
                </label>
                <input
                  type="text"
                  value={contractor}
                  onChange={(e) => setContractor(e.target.value)}
                  placeholder="e.g. TAWUNIYA, BUPA, CASH..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Additional Notes
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Clinical reasons or transfer notes..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loadingAction}
                  className="px-5 py-2 text-sm font-bold bg-[#0b3c34] hover:bg-teal-900 text-white rounded-xl shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {loadingAction ? 'Saving...' : 'Save Transfer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Add Next Step to Patient */}
      {stepModalPatient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" dir="ltr">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-slate-200 overflow-hidden text-left">
            <div className="px-6 py-4 bg-[#0b3c34] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Plus size={18} className="text-teal-300" />
                <h3 className="font-bold text-base">Add Next Transfer Destination</h3>
              </div>
              <button
                onClick={() => setStepModalPatient(null)}
                className="text-teal-200 hover:text-white cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddNextStep} className="p-6 space-y-4">
              <div className="bg-teal-50 p-3 rounded-xl border border-teal-100 text-xs">
                <div className="font-bold text-[#0b3c34]">{stepModalPatient.name}</div>
                <div className="text-teal-800 mt-1">
                  Current Location: <span className="font-bold">{stepModalPatient.currentRoom}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Next Destination Room or Unit (To) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={nextToRoom}
                  onChange={(e) => setNextToRoom(e.target.value)}
                  placeholder="e.g. PICU Room 2 or 405"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Transfer Date & Time
                </label>
                <input
                  type="text"
                  value={stepDate}
                  onChange={(e) => setStepDate(e.target.value)}
                  placeholder="Auto-assigned if empty"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#0b3c34]/20 focus:border-[#0b3c34]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setStepModalPatient(null)}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loadingAction}
                  className="px-5 py-2 text-sm font-bold bg-[#0b3c34] hover:bg-teal-900 text-white rounded-xl shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {loadingAction ? 'Updating...' : 'Update Journey'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Timeline History */}
      {historyPatient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in" dir="ltr">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl border border-slate-200 overflow-hidden text-left">
            <div className="px-6 py-4 bg-[#0b3c34] text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History size={18} className="text-teal-300" />
                <h3 className="font-bold text-base">Detailed Patient Transfer Journey</h3>
              </div>
              <button
                onClick={() => setHistoryPatient(null)}
                className="text-teal-200 hover:text-white cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <h4 className="text-lg font-black text-slate-900">{historyPatient.name}</h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  Current Room: <span className="font-bold text-emerald-700 font-mono">{historyPatient.currentRoom}</span> | Physician: {historyPatient.physician || '-'}
                </p>
              </div>

              <div className="py-2">
                <div className="text-xs font-bold text-slate-600 mb-3">Chronological Movement Steps:</div>
                <div className="relative border-l-2 border-teal-600 pl-6 space-y-6 ml-3">
                  {historyPatient.history && historyPatient.history.length > 0 ? (
                    historyPatient.history.map((step, idx) => (
                      <div key={idx} className="relative">
                        <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-teal-600 border-2 border-white" />
                        <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                          <div className="flex items-center justify-between gap-2 text-xs font-bold text-slate-800">
                            <span className="text-slate-500">From {step.fromRoom} ➔ To <span className="text-emerald-700">{step.toRoom}</span></span>
                            <span className="text-slate-400 font-mono">{step.date}</span>
                          </div>
                          {step.physician && (
                            <div className="text-[11px] text-slate-500 mt-1">
                              Physician: {step.physician}
                            </div>
                          )}
                          {step.contractor && (
                            <div className="text-[11px] text-slate-500">
                              Contractor: {step.contractor}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-slate-500">
                      Transfer Journey: {(historyPatient.journey || []).join(' ➔ ')}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setHistoryPatient(null)}
                  className="px-5 py-2 text-sm font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
