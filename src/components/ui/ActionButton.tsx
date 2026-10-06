import React from 'react';

export interface ActionButtonProps {
  icon: React.ReactElement;
  label: string;
  onClick: () => void;
  loading?: boolean;
}

export function ActionButton({ icon, label, onClick, loading }: ActionButtonProps) {
  return (
    <button 
      onClick={onClick}
      disabled={loading}
      className="w-full text-left px-3.5 py-2.5 min-h-[44px] text-xs bg-white border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 transition-colors shadow-sm flex items-center gap-2.5 font-bold uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {React.cloneElement(icon, { className: `w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}` } as any)}
      {label}
    </button>
  );
}
