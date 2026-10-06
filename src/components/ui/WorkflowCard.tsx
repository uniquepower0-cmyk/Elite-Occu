import React from 'react';
import { ArrowRightLeft } from 'lucide-react';

export interface WorkflowCardProps {
  title: string;
  description: string;
  icon: React.ReactElement;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}

export function WorkflowCard({ 
  title, 
  description, 
  icon, 
  actionLabel, 
  onAction, 
  disabled 
}: WorkflowCardProps) {
  return (
    <div className={`bg-white/60 backdrop-blur-md p-6 rounded-2xl border border-white/45 shadow-sm flex flex-col hover:border-teal-500/40 hover:shadow-md transition-all group ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div className="mb-4 p-3.5 bg-teal-500/10 rounded-xl w-fit group-hover:bg-teal-500/20 transition-all shadow-sm">
        {React.cloneElement(icon, { className: 'w-7 h-7 text-brand-primary transition-transform group-hover:scale-110' } as any)}
      </div>
      <h3 className="text-base font-extrabold mb-2 text-brand-primary tracking-tight">{title}</h3>
      <p className="text-slate-600 text-[12px] mb-6 leading-relaxed font-semibold">
        {description}
      </p>
      <button 
        onClick={onAction}
        disabled={disabled}
        className="mt-auto py-3 px-5 bg-brand-primary text-white rounded-xl font-bold text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-brand-hover transition-all active:scale-95 shadow-md shadow-teal-900/10 disabled:bg-slate-300"
      >
        {actionLabel}
        <ArrowRightLeft className="w-3.5 h-3.5 text-teal-100" />
      </button>
    </div>
  );
}
