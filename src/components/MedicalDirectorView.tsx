import React from 'react';
import { FileSpreadsheet, FileText } from 'lucide-react';
import { WorkflowCard } from './ui/WorkflowCard';

export interface MedicalDirectorViewProps {
  processing: string | null;
  onDownloadCombinedReport: () => void;
  onDownloadMedicalPlans: () => void;
}

export function MedicalDirectorView({
  processing,
  onDownloadCombinedReport,
  onDownloadMedicalPlans,
}: MedicalDirectorViewProps) {
  const isDownloadingCombined = processing === 'Downloading Medical Director & Inpatient Manager Combined Report';
  const isDownloadingPlans = processing === 'Downloading Medical Plans';

  return (
    <section>
      <div className="mb-6 pb-3 border-b border-slate-200 dark:border-emerald-500/20">
        <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50 tracking-tight">
          Medical Director & Inpatient Manager
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Executive inpatient workbooks and structured SBAR clinical plans
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <WorkflowCard 
          title="Combined Inpatient & Medical Director Sheet"
          description="Download a single combined workbook including: Formatted Occupancy, Inpatient Summary Sheet, Closed Units Summary, Inpatients By Specialty, and LOS Sheet."
          icon={<FileSpreadsheet className="text-emerald-700" />}
          actionLabel={isDownloadingCombined ? 'Generating Combined Report...' : 'Download Combined Workbook'}
          onAction={onDownloadCombinedReport}
          disabled={!!processing}
          isLoading={isDownloadingCombined}
        />
        <WorkflowCard 
          title="Medical Plans Sheet"
          description="Download structured SBAR medical plans (تطورات الحالات) extracted from the debt source."
          icon={<FileText className="text-teal-600" />}
          actionLabel={isDownloadingPlans ? 'Generating...' : 'Download Medical Plans'}
          onAction={onDownloadMedicalPlans}
          disabled={!!processing}
          isLoading={isDownloadingPlans}
        />
      </div>
    </section>
  );
}

export default MedicalDirectorView;
