import React from 'react';
import { ArrowRightLeft, RefreshCw } from 'lucide-react';

export interface WorkflowCardProps {
  title: string;
  description: string;
  icon: React.ReactElement;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  secondaryIcon?: React.ReactElement;
  secondaryDisabled?: boolean;
  secondaryLoading?: boolean;
  tertiaryActionLabel?: string;
  onTertiaryAction?: () => void;
  tertiaryIcon?: React.ReactElement;
  tertiaryDisabled?: boolean;
  tertiaryLoading?: boolean;
}

export const WorkflowCard = React.memo(function WorkflowCard({ 
  title, 
  description, 
  icon, 
  actionLabel, 
  onAction, 
  disabled,
  isLoading,
  secondaryActionLabel,
  onSecondaryAction,
  secondaryIcon,
  secondaryDisabled,
  secondaryLoading,
  tertiaryActionLabel,
  onTertiaryAction,
  tertiaryIcon,
  tertiaryDisabled,
  tertiaryLoading
}: WorkflowCardProps) {
  const isPrimaryBusy = disabled || isLoading;
  const isSecondaryBusy = disabled || secondaryDisabled || secondaryLoading;
  const isTertiaryBusy = disabled || tertiaryDisabled || tertiaryLoading;

  return (
    <div className={`bg-white/60 backdrop-blur-md p-6 rounded-2xl border border-white/45 shadow-sm flex flex-col hover:border-teal-500/40 hover:shadow-md transition-all group ${disabled && !isLoading ? 'opacity-60' : ''}`}>
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
          disabled={isPrimaryBusy}
          aria-busy={isLoading}
          className="w-full py-3 px-5 bg-brand-primary text-white rounded-xl font-bold text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-brand-hover transition-all active:scale-95 shadow-md shadow-teal-900/10 disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer"
        >
          {isLoading ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-teal-200" />
              <span>{actionLabel}</span>
            </>
          ) : (
            <>
              <span>{actionLabel}</span>
              <ArrowRightLeft className="w-3.5 h-3.5 text-teal-100" />
            </>
          )}
        </button>

        {secondaryActionLabel && onSecondaryAction && (
          <button 
            onClick={onSecondaryAction}
            disabled={isSecondaryBusy}
            aria-busy={secondaryLoading}
            className="w-full py-2.5 px-4 bg-emerald-600 text-white rounded-xl font-bold text-[10px] tracking-wider flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all active:scale-95 shadow-md shadow-emerald-900/10 disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer"
          >
            {secondaryLoading ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-200" />
            ) : (
              secondaryIcon || <ArrowRightLeft className="w-3.5 h-3.5 text-emerald-100" />
            )}
            <span>{secondaryActionLabel}</span>
          </button>
        )}

        {tertiaryActionLabel && onTertiaryAction && (
          <button 
            onClick={onTertiaryAction}
            disabled={isTertiaryBusy}
            aria-busy={tertiaryLoading}
            className="w-full py-2.5 px-4 bg-[#0a463c] text-white rounded-xl font-bold text-[10px] tracking-wider flex items-center justify-center gap-2 hover:bg-[#07362e] transition-all active:scale-95 shadow-md shadow-teal-950/15 disabled:bg-slate-300 disabled:cursor-not-allowed cursor-pointer"
          >
            {tertiaryLoading ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-teal-200" />
            ) : (
              tertiaryIcon || <ArrowRightLeft className="w-3.5 h-3.5 text-teal-200" />
            )}
            <span>{tertiaryActionLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
});
