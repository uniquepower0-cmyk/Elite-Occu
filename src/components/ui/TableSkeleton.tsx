import React from 'react';

export interface TableSkeletonProps {
  rows?: number;
  cols?: number;
  className?: string;
}

export const TableSkeleton: React.FC<TableSkeletonProps> = ({
  rows = 5,
  cols = 6,
  className = '',
}) => {
  return (
    <div
      role="status"
      aria-label="Loading tabular data..."
      className={`w-full space-y-3 p-4 bg-white/60 backdrop-blur-md rounded-2xl border border-teal-500/10 shadow-sm animate-pulse ${className}`}
    >
      <div className="h-9 bg-teal-900/10 rounded-xl w-full" />
      <div className="space-y-2.5 pt-1">
        {Array.from({ length: rows }).map((_, rIdx) => (
          <div key={rIdx} className="flex gap-3 items-center py-1 border-b border-teal-500/5 last:border-b-0">
            {Array.from({ length: cols }).map((_, cIdx) => (
              <div
                key={cIdx}
                className="h-5 bg-slate-200/70 rounded-md"
                style={{
                  width: cIdx === 0 ? '40px' : cIdx === 1 ? '70px' : '100%',
                  opacity: Math.max(0.4, 1 - (cIdx * 0.12)),
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading content...</span>
    </div>
  );
};

export default TableSkeleton;
