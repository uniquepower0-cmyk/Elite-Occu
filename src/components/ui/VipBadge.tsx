import React from 'react';
import { Crown } from 'lucide-react';

export interface VipBadgeProps {
  size?: 'sm' | 'md';
  className?: string;
}

export const VipBadge: React.FC<VipBadgeProps> = ({ size = 'sm', className = '' }) => {
  const sizeClasses =
    size === 'md'
      ? 'px-2.5 py-0.5 text-[11px] gap-1.5'
      : 'px-1.5 py-0.5 text-[10px] gap-1';

  return (
    <span
      title="VIP Patient"
      className={`inline-flex items-center font-extrabold uppercase tracking-wider rounded-full bg-amber-100 text-amber-800 border border-amber-300/80 dark:bg-amber-500/20 dark:text-amber-200 dark:border-amber-400/40 shrink-0 shadow-xs ${sizeClasses} ${className}`}
    >
      <Crown className={size === 'md' ? 'w-3.5 h-3.5 text-amber-600 dark:text-amber-300' : 'w-2.5 h-2.5 text-amber-600 dark:text-amber-300'} />
      VIP
    </span>
  );
};
