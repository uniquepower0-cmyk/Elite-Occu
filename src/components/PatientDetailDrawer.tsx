import React, { useEffect } from 'react';
import { VipBadge } from './ui/VipBadge';
import {
  X,
  User,
  Calendar,
  CreditCard,
  Activity,
  Crown,
  AlertCircle,
  ArrowRightLeft,
  Copy,
  LogOut,
  Building2,
  ShieldAlert,
} from 'lucide-react';
import { PatientRow, getGroup, isCashPayment } from '../logic/occupancy';
import { InsuranceApprovalItem, PatientTransferRecord } from '../types';

interface PatientDetailDrawerProps {
  patient: PatientRow | null;
  onClose: () => void;
  orMatch?: any | null;
  losMatch?: any | null;
  transferMatch?: PatientTransferRecord | null;
  approvalMatch?: InsuranceApprovalItem | null;
  isVip?: boolean;
  onCopySummary: (patient: PatientRow) => void;
  onAddVip?: (patient: PatientRow) => void;
  onMarkPendingDischarge?: (patient: PatientRow) => void;
  onOpenTransfers?: () => void;
}

export const PatientDetailDrawer: React.FC<PatientDetailDrawerProps> = ({
  patient,
  onClose,
  orMatch,
  losMatch,
  transferMatch,
  approvalMatch,
  isVip,
  onCopySummary,
  onAddVip,
  onMarkPendingDischarge,
  onOpenTransfers,
}) => {
  useEffect(() => {
    if (!patient) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [patient, onClose]);

  if (!patient) return null;

  const zone = getGroup(patient.room);
  const cash = isCashPayment(patient.payment);
  const losVal = losMatch ? parseFloat(losMatch.colS) : NaN;
  const alosLimit = losMatch ? parseFloat(losMatch.colAL) : NaN;
  const isExceedingALOS = !isNaN(losVal) && !isNaN(alosLimit) && losVal > alosLimit;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/45 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={`Patient details for ${patient.name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md bg-white dark:bg-[#0f201c] h-full border-l border-slate-200 dark:border-emerald-500/20 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-200 dark:border-emerald-500/20 flex items-start justify-between gap-4 bg-slate-50/70 dark:bg-[#0b1815]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span className="px-2.5 py-0.5 rounded-md bg-brand-primary text-white font-mono text-xs font-bold">
                Room {patient.room}
              </span>
              <span className="px-2 py-0.5 rounded-md bg-slate-200/80 dark:bg-[#142924] text-slate-700 dark:text-slate-300 text-[11px] font-bold">
                {zone}
              </span>
              {isVip && <VipBadge size="md" />}
              {isExceedingALOS && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 border border-rose-200 text-[11px] font-bold">
                  <AlertCircle className="w-3 h-3" />
                  Exceeding ALOS
                </span>
              )}
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50 leading-snug break-words">
              {patient.name || 'Unnamed Patient'}
            </h3>
            {patient.id && (
              <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                MRN: {patient.id}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-emerald-950/60 cursor-pointer shrink-0"
            aria-label="Close patient details"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          {/* Core Attributes */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#142924] border border-slate-200/80 dark:border-emerald-500/15">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <User className="w-3 h-3" /> Treating Physician
              </div>
              <div className="text-xs font-bold text-slate-800 dark:text-slate-100 mt-1">
                {patient.doctor ? `Dr. ${patient.doctor}` : 'Not assigned'}
              </div>
            </div>
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#142924] border border-slate-200/80 dark:border-emerald-500/15">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Calendar className="w-3 h-3" /> Admission Date
              </div>
              <div className="text-xs font-mono font-bold text-slate-800 dark:text-slate-100 mt-1 tabular-nums">
                {patient.date || 'N/A'}
              </div>
            </div>
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#142924] border border-slate-200/80 dark:border-emerald-500/15 col-span-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <CreditCard className="w-3 h-3" /> Payer / Contractor
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                  {patient.payment || 'Unknown'}
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    cash
                      ? 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300'
                      : 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
                  }`}
                >
                  {cash ? 'Cash' : 'Insured'}
                </span>
              </div>
            </div>
          </div>

          {/* ALOS Status */}
          {losMatch && (
            <div className="p-4 rounded-xl border border-slate-200 dark:border-emerald-500/20 bg-white dark:bg-[#0b1815] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <Building2 className="w-4 h-4 text-teal-600" />
                  Length of Stay (LOS vs Elite ALOS)
                </span>
                <span
                  className={`text-xs font-mono font-bold tabular-nums ${
                    isExceedingALOS ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {losMatch.colS || '—'} / {losMatch.colAL || '—'} days
                </span>
              </div>
              {losMatch.colM && losMatch.colM !== patient.payment && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Contractor / Payer: <strong className="text-slate-700 dark:text-slate-200">{losMatch.colM}</strong>
                </p>
              )}
            </div>
          )}

          {/* OR Schedule Cross-Reference */}
          {/* Insurance Approvals Cross-Reference */}
          {approvalMatch && (
            <div
              className={`p-4 rounded-xl border space-y-2 ${
                approvalMatch.severity === 'critical'
                  ? 'border-rose-200 dark:border-rose-500/30 bg-rose-50/50 dark:bg-rose-950/25'
                  : approvalMatch.severity === 'warning'
                  ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/25'
                  : 'border-slate-200 dark:border-emerald-500/20 bg-slate-50/60 dark:bg-[#142924]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <ShieldAlert
                    className={`w-4 h-4 ${
                      approvalMatch.severity === 'critical'
                        ? 'text-rose-600 dark:text-rose-400'
                        : approvalMatch.severity === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-emerald-600 dark:text-emerald-400'
                    }`}
                  />
                  Insurance Approvals
                </span>
                <span className="text-[11px] font-mono font-bold tabular-nums text-slate-700 dark:text-slate-200">
                  {approvalMatch.rejectedRequests} rej · {approvalMatch.pendingRequests + approvalMatch.inProgressRequests} open · {approvalMatch.closedRequests} done
                </span>
              </div>
              <div className="text-xs text-slate-700 dark:text-slate-200 font-medium">
                {approvalMatch.contractor}
                {approvalMatch.agentName ? ` · Agent: ${approvalMatch.agentName}` : ''}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Status: {approvalMatch.status || '—'} · Uploaded: {approvalMatch.uploadedApprovals}
              </div>
              {approvalMatch.invoiceComment && (
                <p className="text-[11px] text-slate-600 dark:text-slate-300 bg-white/70 dark:bg-[#0b1815]/60 rounded-lg p-2 border border-slate-200/70 dark:border-emerald-500/15">
                  {approvalMatch.invoiceComment}
                </p>
              )}
            </div>
          )}

          {orMatch && (
            <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/50 dark:bg-indigo-950/30 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5">
                  <Activity className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  Scheduled in Operating Room
                </span>
                <span className="text-xs font-mono font-bold text-indigo-700 dark:text-indigo-300">
                  {orMatch.orRoom} ({orMatch.startTime || '--:--'} - {orMatch.endTime || '--:--'})
                </span>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-200 font-semibold">
                {orMatch.engOperationName || orMatch.arOperationName || 'Surgical Procedure'}
              </p>
              {orMatch.surgeonName && (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Surgeon: {orMatch.surgeonName}
                </p>
              )}
            </div>
          )}

          {/* Transfer Journey Cross-Reference */}
          {transferMatch && Array.isArray(transferMatch.journey) && transferMatch.journey.length > 0 && (
            <div className="p-4 rounded-xl border border-slate-200 dark:border-emerald-500/20 bg-white dark:bg-[#0b1815] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <ArrowRightLeft className="w-4 h-4 text-teal-600" />
                  Room Transfer Journey
                </span>
                {onOpenTransfers && (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenTransfers();
                    }}
                    className="text-[11px] font-bold text-brand-primary hover:underline cursor-pointer"
                  >
                    Open Registry
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
                {transferMatch.journey.map((rm, idx) => (
                  <React.Fragment key={idx}>
                    <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-[#142924] font-bold text-slate-800 dark:text-slate-200">
                      {rm}
                    </span>
                    {idx < transferMatch.journey.length - 1 && (
                      <span className="text-slate-400">→</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Quick Actions */}
        <div className="p-4 border-t border-slate-200 dark:border-emerald-500/20 bg-slate-50/70 dark:bg-[#0b1815] space-y-2">
          <button
            type="button"
            onClick={() => onCopySummary(patient)}
            className="w-full py-2.5 px-4 bg-brand-primary hover:bg-brand-hover text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition active:scale-[0.98] cursor-pointer"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy Patient Summary
          </button>

          <div className="grid grid-cols-2 gap-2">
            {onAddVip && !isVip && (
              <button
                type="button"
                onClick={() => onAddVip(patient)}
                className="py-2 px-3 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-[0.98] cursor-pointer"
              >
                <Crown className="w-3.5 h-3.5" />
                Flag as VIP
              </button>
            )}
            {onMarkPendingDischarge && (
              <button
                type="button"
                onClick={() => onMarkPendingDischarge(patient)}
                className={`py-2 px-3 bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-[0.98] cursor-pointer ${
                  !onAddVip || isVip ? 'col-span-2' : ''
                }`}
              >
                <LogOut className="w-3.5 h-3.5" />
                Queue Pending Discharge
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
