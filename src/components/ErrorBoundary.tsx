import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackSubtitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    } else {
      window.location.reload();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div 
          role="alert" 
          aria-live="assertive"
          className="p-8 my-6 bg-rose-50/90 border border-rose-200 rounded-2xl shadow-sm backdrop-blur-md max-w-2xl mx-auto flex flex-col items-center text-center animate-fade-in"
        >
          <div className="w-12 h-12 rounded-full bg-rose-150 flex items-center justify-center text-rose-700 mb-4 shadow-sm">
            <AlertTriangle className="w-6 h-6" />
          </div>
          
          <h3 className="text-lg font-extrabold text-slate-900 mb-1">
            {this.props.fallbackTitle || 'Clinical View Encountered an Error'}
          </h3>
          
          <p className="text-xs text-slate-600 max-w-md mb-6 leading-relaxed font-medium">
            {this.props.fallbackSubtitle || 'A temporary issue prevented this module from rendering properly. This may be caused by a network interruption during module retrieval.'}
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-brand-primary hover:bg-brand-hover text-white text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload View
            </button>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = '#';
              }}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-bold rounded-xl transition-all shadow-sm active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 cursor-pointer"
            >
              <Home className="w-3.5 h-3.5 text-slate-500" />
              Return to Dashboard
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
