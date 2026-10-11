import React from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

export interface ErrorBannerProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  title = 'Something went wrong',
  message,
  onRetry,
  onDismiss,
  className = '',
}) => {
  return (
    <div
      role="alert"
      className={`p-4 bg-rose-50/95 border border-rose-200/90 rounded-2xl shadow-sm flex items-start justify-between gap-3 text-rose-950 my-3 animate-fade-in ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <h5 className="text-xs font-extrabold uppercase tracking-wide text-rose-900">{title}</h5>
          <p className="text-xs text-rose-700 mt-0.5 leading-relaxed font-medium">{message}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shadow-sm active:scale-95 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
          >
            <RefreshCw size={12} aria-hidden="true" />
            Retry
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error banner"
            className="p-1 text-rose-500 hover:text-rose-800 rounded-lg hover:bg-rose-100 transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
};

export default ErrorBanner;
