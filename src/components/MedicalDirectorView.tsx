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
  return (
    <section>
      <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
        <h3 className="text-xl font-extrabold text-brand-primary tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">
          Medical Director & Inpatient manager
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <WorkflowCard 
          title="Combined Inpatient & Medical Director Sheet"
          description="Download a single combined workbook including: Formatted Occupancy, Inpatient Summary Sheet, Closed Units Summary, Inpatients By Specialty, and LOS Sheet."
          icon={<FileSpreadsheet className="text-emerald-700" />}
          actionLabel={processing === 'Downloading Medical Director & Inpatient Manager Combined Report' ? 'Generating Combined Report...' : 'Download Combined Workbook'}
          onAction={onDownloadCombinedReport}
          disabled={!!processing}
        />
        <WorkflowCard 
          title="Medical Plans Sheet"
          description="Download structured SBAR medical plans (تطورات الحالات) extracted from the debt source."
          icon={<FileText className="text-teal-600" />}
          actionLabel={processing === 'Downloading Medical Plans' ? 'Generating...' : 'Download Medical Plans'}
          onAction={onDownloadMedicalPlans}
          disabled={!!processing}
        />
      </div>
    </section>
  );
}

export default MedicalDirectorView;
