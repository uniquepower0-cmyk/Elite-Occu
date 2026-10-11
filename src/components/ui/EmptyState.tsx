import React from 'react';
import { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}) => {
  return (
    <div
      role="status"
      className={`flex flex-col items-center justify-center p-8 text-center bg-white/50 backdrop-blur-sm rounded-2xl border border-dashed border-teal-500/20 my-4 ${className}`}
    >
      <div className="w-12 h-12 rounded-2xl bg-teal-50 text-teal-700 flex items-center justify-center mb-3 shadow-inner">
        <Icon className="w-6 h-6 text-teal-700" aria-hidden="true" />
      </div>
      <h4 className="text-sm font-extrabold text-[#0b3c34] mb-1">{title}</h4>
      <p className="text-xs text-slate-500 max-w-sm mb-4 leading-relaxed font-medium">{description}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="px-4 py-2 text-xs font-bold text-teal-900 bg-teal-100 hover:bg-teal-200 rounded-xl transition-all shadow-xs active:scale-95 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        >
          {action.label}
        </button>
      )}
    </div>
  );
};

export default EmptyState;
