import React from 'react';
import { ArrowRightLeft } from 'lucide-react';

export interface WorkflowCardProps {
  title: string;
  description: string;
  icon: React.ReactElement;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  secondaryIcon?: React.ReactElement;
  secondaryDisabled?: boolean;
  tertiaryActionLabel?: string;
  onTertiaryAction?: () => void;
  tertiaryIcon?: React.ReactElement;
  tertiaryDisabled?: boolean;
}

export function WorkflowCard({ 
  title, 
  description, 
  icon, 
  actionLabel, 
  onAction, 
  disabled,
  secondaryActionLabel,
  onSecondaryAction,
  secondaryIcon,
  secondaryDisabled,
  tertiaryActionLabel,
  onTertiaryAction,
  tertiaryIcon,
  tertiaryDisabled
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
      <div className="mt-auto flex flex-col gap-2">
        <button 
          onClick={onAction}
          disabled={disabled}
          className="w-full py-3 px-5 bg-brand-primary text-white rounded-xl font-bold text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-brand-hover transition-all active:scale-95 shadow-md shadow-teal-900/10 disabled:bg-slate-300"
        >
          {actionLabel}
          <ArrowRightLeft className="w-3.5 h-3.5 text-teal-100" />
        </button>

        {secondaryActionLabel && onSecondaryAction && (
          <button 
            onClick={onSecondaryAction}
            disabled={secondaryDisabled || disabled}
            className="w-full py-2.5 px-4 bg-emerald-600 text-white rounded-xl font-bold text-[10px] tracking-wider flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all active:scale-95 shadow-md shadow-emerald-900/10 disabled:bg-slate-300"
          >
            {secondaryIcon || <ArrowRightLeft className="w-3.5 h-3.5 text-emerald-100" />}
            {secondaryActionLabel}
          </button>
        )}

        {tertiaryActionLabel && onTertiaryAction && (
          <button 
            onClick={onTertiaryAction}
            disabled={tertiaryDisabled || disabled}
            className="w-full py-2.5 px-4 bg-[#0a463c] text-white rounded-xl font-bold text-[10px] tracking-wider flex items-center justify-center gap-2 hover:bg-[#07362e] transition-all active:scale-95 shadow-md shadow-teal-950/15 disabled:bg-slate-300"
          >
            {tertiaryIcon || <ArrowRightLeft className="w-3.5 h-3.5 text-teal-200" />}
            {tertiaryActionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
