import React from 'react';

export interface NavItemProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactElement;
  label: string;
  highlighted?: boolean;
  badge?: string;
}

export function NavItem({ active, onClick, icon, label, highlighted, badge }: NavItemProps) {
  return (
    <button 
      onClick={onClick}
      className={`flex items-center justify-between w-full px-3.5 py-2.5 min-h-[44px] rounded-xl transition-all text-sm font-medium relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
        active 
          ? 'bg-brand-primary text-white shadow-md shadow-teal-900/10' 
          : highlighted
            ? 'bg-amber-500/15 text-amber-700 hover:text-amber-900 hover:bg-amber-500/20 border-2 border-amber-500/30 shadow-[0_0_12px_rgba(245,158,11,0.25)] animate-pulse'
            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {React.cloneElement(icon, { className: 'w-4 h-4 shrink-0' } as any)}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        {badge && (
          <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-full ${
            active ? 'bg-white/20 text-white' : 'bg-teal-500/10 text-teal-800'
          }`}>
            {badge}
          </span>
        )}
        {highlighted && !active && (
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
        )}
      </div>
    </button>
  );
}
