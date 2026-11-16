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
  tertiaryLoading,
}: WorkflowCardProps) {
  const isPrimaryBusy = disabled || isLoading;
  const isSecondaryBusy = disabled || secondaryDisabled || secondaryLoading;
  const isTertiaryBusy = disabled || tertiaryDisabled || tertiaryLoading;

  return (
    <div
      className={`bg-white dark:bg-[#0f201c] p-5 rounded-xl border border-slate-200/90 dark:border-emerald-500/20 shadow-[0_1px_2px_rgba(15,23,42,0.04)] flex flex-col hover:border-teal-600/40 dark:hover:border-emerald-400/40 hover:shadow-md transition-all duration-150 group ${
        disabled && !isLoading ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start gap-3.5 mb-3">
        <div className="p-2.5 bg-teal-50 dark:bg-emerald-950/60 border border-teal-100 dark:border-emerald-500/20 rounded-lg w-fit shrink-0">
          {React.cloneElement(icon, {
            className: 'w-5 h-5 text-brand-primary dark:text-emerald-400',
          } as any)}
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-50 tracking-tight leading-snug">
            {title}
          </h3>
        </div>
      </div>

      <p className="text-slate-600 dark:text-slate-300 text-xs mb-5 leading-relaxed">
        {description}
      </p>

      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={onAction}
          disabled={isPrimaryBusy}
          aria-busy={isLoading}
          className="w-full py-2.5 px-4 bg-brand-primary text-white rounded-lg font-semibold text-xs flex items-center justify-center gap-2 hover:bg-brand-hover transition-all active:scale-[0.98] shadow-xs disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed cursor-pointer"
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
            type="button"
            onClick={onSecondaryAction}
            disabled={isSecondaryBusy}
            aria-busy={secondaryLoading}
            className="w-full py-2 px-4 bg-emerald-600 text-white rounded-lg font-semibold text-xs flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all active:scale-[0.98] shadow-xs disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed cursor-pointer"
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
            type="button"
            onClick={onTertiaryAction}
            disabled={isTertiaryBusy}
            aria-busy={tertiaryLoading}
            className="w-full py-2 px-4 bg-slate-800 dark:bg-emerald-950 text-white rounded-lg font-semibold text-xs flex items-center justify-center gap-2 hover:bg-slate-900 dark:hover:bg-emerald-900 transition-all active:scale-[0.98] shadow-xs disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:cursor-not-allowed cursor-pointer"
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
