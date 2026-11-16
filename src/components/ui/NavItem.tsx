import React from 'react';

export interface NavItemProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactElement;
  label: string;
  highlighted?: boolean;
  badge?: string;
}

export const NavItem = React.memo(function NavItem({
  active,
  onClick,
  icon,
  label,
  highlighted,
  badge,
}: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between w-full px-3 py-2.5 min-h-[40px] rounded-xl transition-colors duration-150 text-[13px] font-semibold relative cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary active:scale-[0.99] ${
        active
          ? 'bg-brand-primary text-white shadow-sm'
          : highlighted
            ? 'text-slate-800 dark:text-slate-100 bg-teal-50/70 dark:bg-emerald-950/40 border border-teal-200/80 dark:border-emerald-500/25 hover:bg-teal-100/70 dark:hover:bg-emerald-900/40'
            : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-emerald-950/40'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {React.cloneElement(icon, {
          className: `w-4 h-4 shrink-0 ${
            active
              ? 'text-emerald-200'
              : highlighted
                ? 'text-teal-700 dark:text-emerald-400'
                : 'text-slate-400 dark:text-slate-500'
          }`,
        } as any)}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        {badge && (
          <span
            className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded-md ${
              active
                ? 'bg-white/20 text-white'
                : 'bg-slate-100 dark:bg-emerald-950/70 text-slate-600 dark:text-emerald-300'
            }`}
          >
            {badge}
          </span>
        )}
        {highlighted && !active && (
          <span className="w-1.5 h-1.5 rounded-full bg-teal-600 dark:bg-emerald-400" />
        )}
      </div>
    </button>
  );
});
