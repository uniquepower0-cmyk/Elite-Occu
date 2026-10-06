import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export interface StatCardProps {
  label: string;
  value: string;
  subValue: string;
  icon: React.ReactElement;
  color?: string;
  onCopy?: () => void;
  copyLabel?: string;
  highlighted?: boolean;
}

export function StatCard({ 
  label, 
  value, 
  subValue, 
  icon, 
  onCopy, 
  copyLabel, 
  highlighted 
}: StatCardProps) {
  const [copied, setCopied] = useState(false);
  const isHighlighted = highlighted || label.toUpperCase().includes('TOTAL OCCUPIED') || label.toUpperCase().includes('AVAILABLE') || label.toUpperCase().includes('EXCEEDING') || label.toUpperCase().includes('VIP') || label.toUpperCase().includes('INPATIENT OCCUPANCY');

  const renderMiniChart = (lbl: string) => {
    const uLabel = lbl.toUpperCase();
    
    if (uLabel.includes("TOTAL OCCUPIED") || uLabel.includes("CASH") || uLabel.includes("DISCHARGED") || uLabel.includes("RATE") || uLabel.includes("OCCUPANCY RATE")) {
      const barHeights = uLabel.includes("TOTAL OCCUPIED") ? [10, 16, 22, 14, 18, 30, 26, 35] :
                         uLabel.includes("CASH") ? [6, 11, 17, 22, 28, 34, 40, 44] :
                         uLabel.includes("DISCHARGED") ? [8, 14, 20, 26, 32, 38, 30, 42] : [8, 14, 20, 26, 32, 38, 32, 44];
      return (
        <svg className="w-full h-11 mt-4 text-[#0e4e43]" viewBox="0 0 120 45">
          <g className="opacity-50">
            {barHeights.map((h, i) => (
              <rect 
                key={i}
                x={12 + i * 12} 
                y={45 - h} 
                width="6" 
                height={h} 
                fill="currentColor" 
                rx="1"
              />
            ))}
          </g>
        </svg>
      );
    }
    
    if (uLabel.includes("INSURED") || uLabel.includes("ENTRY") || uLabel.includes("ENTRIES") || uLabel.includes("CRITICAL") || uLabel.includes("AVAILABLE")) {
      const pathData = uLabel.includes("INSURED") ? "M10,28 L25,36 L40,16 L55,32 L70,22 L85,38 L100,12" :
                       uLabel.includes("AVAILABLE") ? "M10,38 L25,25 L40,32 L55,14 L70,24 L85,36 L100,18" :
                       uLabel.includes("ENTRIES") ? "M10,32 L25,20 L40,36 L55,16 L70,26 L85,38 L100,22" : "M10,34 L25,14 L40,24 L55,10 L70,22 L85,34 L100,16";
      return (
        <svg className="w-full h-11 mt-4 text-[#0e4e43]" viewBox="0 0 110 45">
          <path 
            d={pathData} 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-70"
          />
        </svg>
      );
    }
    
    return (
      <svg className="w-full h-11 mt-4 text-[#0e4e43]" viewBox="0 0 100 45">
        <g className="opacity-30">
          {[12, 22, 18, 28, 32, 38].map((h, i) => (
            <rect key={i} x={10 + i * 14} y={45 - h} width="6" height={h} fill="currentColor" rx="1" />
          ))}
        </g>
      </svg>
    );
  };

  return (
    <div 
      className={`p-5 rounded-2xl border transition-all duration-300 flex flex-col justify-between group h-full relative overflow-hidden backdrop-blur-md ${
        isHighlighted 
          ? label.toUpperCase().includes('EXCEEDING')
            ? 'bg-amber-500/10 border-amber-400/80 shadow-[0_0_20px_rgba(245,158,11,0.25)]'
            : 'bg-emerald-500/10 border-teal-400/80 shadow-[0_0_20px_rgba(20,184,166,0.25)]' 
          : 'bg-white/45 border-white/40 shadow-sm hover:border-white/60 hover:shadow-md'
      }`}
      style={{
        backgroundImage: 'radial-gradient(rgba(14, 78, 67, 0.08) 1.2px, transparent 1.2px)',
        backgroundSize: '12px 12px'
      }}
    >
      <div className="flex justify-between items-start mb-6">
        <div className="w-10 h-10 rounded-full flex items-center justify-center bg-teal-500/10 text-emerald-800 shadow-[0_0_15px_rgba(20,184,166,0.25)] relative">
          <div className="absolute inset-0 rounded-full bg-emerald-400/20 blur-sm"></div>
          {React.cloneElement(icon, { className: 'w-5 h-5 relative z-10 text-brand-primary' } as any)}
        </div>
        <div className="text-[10px] font-mono text-slate-400 font-bold">{new Date().getHours()}:00 HR</div>
      </div>
      
      <div className="flex flex-col items-center justify-center flex-1">
        <h2 className="text-3xl font-extrabold text-[#0f172a] mb-1 tracking-tight text-center">{value}</h2>
        <p className="text-[11px] font-black text-[#0f172a]/95 uppercase tracking-widest text-center mt-3">{label}</p>
        <div className="text-[10px] text-slate-500 font-semibold italic text-center mt-1">
          {subValue}
        </div>
        {onCopy && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className={`mt-4 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider transition-all shadow-sm flex items-center gap-1.5 border rounded-lg cursor-pointer z-10 ${
              copied
                ? 'bg-emerald-500/20 text-emerald-800 border-emerald-500/40'
                : 'bg-amber-500/20 text-amber-800 hover:bg-amber-500/30 active:scale-95 border-amber-500/30'
            }`}
            title={copyLabel || "Copy Patients List"}
          >
            {copied ? (
              <>
                <Check size={10} className="stroke-[2.5]" />
                Copied!
              </>
            ) : (
              <>
                <Copy size={10} className="stroke-[2.5]" />
                {copyLabel || "Copy Patients List"}
              </>
            )}
          </button>
        )}
      </div>

      {renderMiniChart(label)}
    </div>
  );
}
