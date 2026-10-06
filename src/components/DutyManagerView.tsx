import React from 'react';
import { FileText } from 'lucide-react';
import { WorkflowCard } from './ui/WorkflowCard';

export interface DutyManagerViewProps {
  processing: string | null;
  onDownloadCombinedReport: () => void;
  onDownloadMedicalPlans: () => void;
}

export function DutyManagerView({
  processing,
  onDownloadCombinedReport,
  onDownloadMedicalPlans,
}: DutyManagerViewProps) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
        <h3 className="text-xl font-extrabold text-brand-primary tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">
          Duty Manager
        </h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <WorkflowCard 
          title="Download Combined Sheet"
          description="Download a single Excel file containing Formatted Occupancy, Entry, and Exit sheets."
          icon={<FileText className="text-indigo-600" />}
          actionLabel={processing === 'Downloading Combined Sheet' ? 'Generating...' : 'Download Combined'}
          onAction={onDownloadCombinedReport}
          disabled={!!processing}
        />
        <WorkflowCard 
          title="Medical Plans Sheet"
          description="Download structured SBAR medical plans (تطورات الحالات) extracted from the debt source."
          icon={<FileText className="text-sky-600" />}
          actionLabel={processing === 'Downloading Medical Plans' ? 'Generating...' : 'Download Medical Plans'}
          onAction={onDownloadMedicalPlans}
          disabled={!!processing}
        />
      </div>
    </section>
  );
}

export default DutyManagerView;
