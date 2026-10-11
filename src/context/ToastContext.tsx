import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, options?: { duration?: number; action?: { label: string; onClick: () => void } }) => string;
  removeToast: (id: string) => void;
  success: (message: string, options?: { duration?: number; action?: { label: string; onClick: () => void } }) => string;
  error: (message: string, options?: { duration?: number; action?: { label: string; onClick: () => void } }) => string;
  info: (message: string, options?: { duration?: number; action?: { label: string; onClick: () => void } }) => string;
  warning: (message: string, options?: { duration?: number; action?: { label: string; onClick: () => void } }) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', options?: { duration?: number; action?: { label: string; onClick: () => void } }) => {
      const id = Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
      const duration = options?.duration ?? (type === 'error' ? 6000 : 4000);
      const newToast: ToastItem = {
        id,
        type,
        message,
        duration,
        action: options?.action,
      };

      setToasts((prev) => [...prev, newToast]);

      if (duration > 0) {
        setTimeout(() => {
          removeToast(id);
        }, duration);
      }

      return id;
    },
    [removeToast]
  );

  const success = useCallback(
    (msg: string, opt?: { duration?: number; action?: { label: string; onClick: () => void } }) =>
      showToast(msg, 'success', opt),
    [showToast]
  );

  const error = useCallback(
    (msg: string, opt?: { duration?: number; action?: { label: string; onClick: () => void } }) =>
      showToast(msg, 'error', opt),
    [showToast]
  );

  const info = useCallback(
    (msg: string, opt?: { duration?: number; action?: { label: string; onClick: () => void } }) =>
      showToast(msg, 'info', opt),
    [showToast]
  );

  const warning = useCallback(
    (msg: string, opt?: { duration?: number; action?: { label: string; onClick: () => void } }) =>
      showToast(msg, 'warning', opt),
    [showToast]
  );

  const value = useMemo(
    () => ({
      showToast,
      removeToast,
      success,
      error,
      info,
      warning,
    }),
    [showToast, removeToast, success, error, info, warning]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Floating Toast Container */}
      <div
        aria-live="polite"
        className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2.5 max-w-md w-full pointer-events-none px-4 sm:px-0"
      >
        {toasts.map((toast) => {
          const isError = toast.type === 'error';
          const isSuccess = toast.type === 'success';
          const isWarning = toast.type === 'warning';

          return (
            <div
              key={toast.id}
              role={isError ? 'alert' : 'status'}
              className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-2xl shadow-xl border backdrop-blur-md transition-all duration-200 animate-slide-up ${
                isError
                  ? 'bg-rose-50/95 border-rose-300 text-rose-950 shadow-rose-900/15'
                  : isSuccess
                  ? 'bg-emerald-50/95 border-emerald-300 text-emerald-950 shadow-emerald-900/15'
                  : isWarning
                  ? 'bg-amber-50/95 border-amber-300 text-amber-950 shadow-amber-900/15'
                  : 'bg-slate-900/95 border-slate-700 text-white shadow-slate-900/25'
              }`}
            >
              <div className="shrink-0 mt-0.5">
                {isError && <AlertCircle className="w-5 h-5 text-rose-600" />}
                {isSuccess && <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
                {isWarning && <AlertTriangle className="w-5 h-5 text-amber-600" />}
                {!isError && !isSuccess && !isWarning && <Info className="w-5 h-5 text-sky-400" />}
              </div>

              <div className="flex-1 text-xs font-semibold leading-relaxed">
                <span>{toast.message}</span>
                {toast.action && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        toast.action?.onClick();
                        removeToast(toast.id);
                      }}
                      className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-black/10 hover:bg-black/15 transition-colors cursor-pointer"
                    >
                      {toast.action.label}
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => removeToast(toast.id)}
                aria-label="Close notification"
                className="shrink-0 p-1 rounded-lg hover:bg-black/10 text-current opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
