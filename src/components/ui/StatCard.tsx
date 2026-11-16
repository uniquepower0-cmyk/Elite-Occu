import React, { useState } from 'react';
import { Copy, Check, ArrowUpRight } from 'lucide-react';

export interface StatCardProps {
  label: string;
  value: string;
  subValue: string;
  icon: React.ReactElement;
  color?: string;
  onCopy?: () => void;
  copyLabel?: string;
  highlighted?: boolean;
  progress?: number;
  badge?: string;
  onClick?: () => void;
}

const ACCENT_STYLES: Record<string, { iconBg: string; iconText: string; bar: string; ring: string }> = {
  teal: {
    iconBg: 'bg-teal-50 dark:bg-teal-950/60',
    iconText: 'text-teal-700 dark:text-teal-300',
    bar: 'bg-teal-600 dark:bg-teal-400',
    ring: 'border-teal-500/35 dark:border-teal-400/35',
  },
  emerald: {
    iconBg: 'bg-emerald-50 dark:bg-emerald-950/60',
    iconText: 'text-emerald-700 dark:text-emerald-300',
    bar: 'bg-emerald-600 dark:bg-emerald-400',
    ring: 'border-emerald-500/35 dark:border-emerald-400/35',
  },
  sky: {
    iconBg: 'bg-sky-50 dark:bg-sky-950/60',
    iconText: 'text-sky-700 dark:text-sky-300',
    bar: 'bg-sky-600 dark:bg-sky-400',
    ring: 'border-sky-500/35 dark:border-sky-400/35',
  },
  blue: {
    iconBg: 'bg-blue-50 dark:bg-blue-950/60',
    iconText: 'text-blue-700 dark:text-blue-300',
    bar: 'bg-blue-600 dark:bg-blue-400',
    ring: 'border-blue-500/35 dark:border-blue-400/35',
  },
  amber: {
    iconBg: 'bg-amber-50 dark:bg-amber-950/50',
    iconText: 'text-amber-700 dark:text-amber-300',
    bar: 'bg-amber-500 dark:bg-amber-400',
    ring: 'border-amber-500/40 dark:border-amber-400/40',
  },
  yellow: {
    iconBg: 'bg-amber-50 dark:bg-amber-950/50',
    iconText: 'text-amber-700 dark:text-amber-300',
    bar: 'bg-amber-500 dark:bg-amber-400',
    ring: 'border-amber-500/40 dark:border-amber-400/40',
  },
  pink: {
    iconBg: 'bg-rose-50 dark:bg-rose-950/50',
    iconText: 'text-rose-700 dark:text-rose-300',
    bar: 'bg-rose-500 dark:bg-rose-400',
    ring: 'border-rose-400/35 dark:border-rose-400/35',
  },
  rose: {
    iconBg: 'bg-rose-50 dark:bg-rose-950/50',
    iconText: 'text-rose-700 dark:text-rose-300',
    bar: 'bg-rose-600 dark:bg-rose-400',
    ring: 'border-rose-400/35 dark:border-rose-400/35',
  },
  indigo: {
    iconBg: 'bg-slate-100 dark:bg-slate-800/70',
    iconText: 'text-slate-700 dark:text-slate-200',
    bar: 'bg-slate-700 dark:bg-slate-300',
    ring: 'border-slate-300 dark:border-slate-600',
  },
  purple: {
    iconBg: 'bg-slate-100 dark:bg-slate-800/70',
    iconText: 'text-slate-700 dark:text-slate-200',
    bar: 'bg-slate-700 dark:bg-slate-300',
    ring: 'border-slate-300 dark:border-slate-600',
  },
  orange: {
    iconBg: 'bg-orange-50 dark:bg-orange-950/50',
    iconText: 'text-orange-700 dark:text-orange-300',
    bar: 'bg-orange-500 dark:bg-orange-400',
    ring: 'border-orange-400/40 dark:border-orange-400/40',
  },
};

export const StatCard = React.memo(function StatCard({
  label,
  value,
  subValue,
  icon,
  color = 'teal',
  onCopy,
  copyLabel,
  highlighted,
  progress,
  badge,
  onClick,
}: StatCardProps) {
  const [copied, setCopied] = useState(false);
  const accent = ACCENT_STYLES[color] || ACCENT_STYLES.teal;
  const clampedProgress =
    typeof progress === 'number' && !isNaN(progress)
      ? Math.max(0, Math.min(100, progress))
      : null;

  const baseBorder = highlighted
    ? accent.ring
    : 'border-slate-200/90 dark:border-emerald-500/20';

  const interactiveClasses = onClick
    ? 'cursor-pointer hover:border-brand-primary/40 hover:shadow-md active:scale-[0.99]'
    : 'hover:border-slate-300/90 dark:hover:border-emerald-500/35';

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={`p-4 rounded-xl bg-white dark:bg-[#0f201c] border transition-all duration-150 flex flex-col group h-full min-w-0 overflow-hidden relative shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${baseBorder} ${interactiveClasses}`}
    >
      {/* Top Row: Label + Icon strictly contained inside card */}
      <div className="flex items-start justify-between gap-2.5 min-h-[32px] mb-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 leading-snug min-w-0 break-words">
          {label}
        </span>
        <div
          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${accent.iconBg} ${accent.iconText}`}
        >
          {React.cloneElement(icon, { className: 'w-3.5 h-3.5' } as any)}
        </div>
      </div>

      {/* Middle Row: Value & SubValue aligned cleanly across all cards */}
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-2xl sm:text-[26px] font-bold text-slate-900 dark:text-slate-50 tracking-tight tabular-nums leading-tight">
            {value}
          </div>
          {badge && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-slate-100 text-slate-700 dark:bg-emerald-950/70 dark:text-emerald-300 shrink-0">
              {badge}
            </span>
          )}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1 flex items-center justify-between gap-1.5 min-w-0">
          <span className="leading-snug break-words">{subValue}</span>
          {onClick && (
            <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          )}
        </div>
      </div>

      {/* Bottom Anchored Section (Progress Bar or Copy Action) */}
      {(clampedProgress !== null || onCopy) && (
        <div className="mt-auto pt-3 space-y-2.5">
          {clampedProgress !== null && (
            <div className="pt-2.5 border-t border-slate-100 dark:border-emerald-500/10">
              <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-800/80 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${accent.bar}`}
                  style={{ width: `${clampedProgress}%` }}
                />
              </div>
            </div>
          )}

          {onCopy && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCopy();
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className={`w-full px-3 py-1.5 text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 border rounded-lg cursor-pointer ${
                copied
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-500/40'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200 active:scale-[0.98] dark:bg-[#142924] dark:hover:bg-[#18332c] dark:text-slate-200 dark:border-emerald-500/20'
              }`}
              title={copyLabel || 'Copy Patients List'}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  <span className="leading-tight whitespace-nowrap">{copyLabel || 'Copy Patients List'}</span>
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
