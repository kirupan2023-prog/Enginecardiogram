import { AlertTriangle, TrendingUp, ChevronDown, ChevronUp } from 'lucide-react';

interface DigitalCardProps {
  id?: string;
  label: string;
  value: number | string;
  min: number;
  max: number;
  unit: string;
  color?: string;
  alert: boolean;
  alertThreshold: number;
  onClick?: () => void;
  isSelected?: boolean;
  isExpanded?: boolean;
  extraBadge?: string;
}

export default function DigitalCard({
  id,
  label,
  value,
  min: _min,
  max: _max,
  unit,
  alert,
  alertThreshold: _alertThreshold,
  onClick,
  isSelected,
  isExpanded,
  extraBadge,
}: DigitalCardProps) {
  const active = Boolean(isSelected || isExpanded);
  const activeColor = alert ? '#FF0000' : active ? '#00FF66' : '#e2ece6';

  return (
    <div
      id={id}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-selected={active}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      className={`telemetry-card relative flex flex-col justify-between px-3 py-2.5 sm:px-4 sm:py-3.5 rounded-none border-2 transition-all duration-150 w-full select-none group ${
        active ? 'is-selected is-active' : ''
      } ${
        alert
          ? 'border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] shadow-[0_0_16px_rgba(255,0,0,0.25)]'
          : active
          ? 'border-[#00FF66] bg-[#0c1611] text-[#e2ece6] shadow-[0_0_18px_rgba(0,255,102,0.25)]'
          : 'border-[#e2ece6]/30 bg-[#0d110f]/80 hover:border-[#00FF66]/80 text-[#e2ece6]'
      } ${onClick ? 'cursor-pointer' : ''}`}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      title={onClick ? `Click to view rolling graph for ${label}` : undefined}
    >
      {/* Top accent bar for active selected state */}
      {active && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-[#00FF66] z-10" />
      )}

      {/* Header row: Parameter Label, Warning alert, Badges & Active GRAPHING badge */}
      <div className="flex items-center justify-between w-full leading-none shrink-0 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`text-[11px] sm:text-xs font-black tracking-wider uppercase font-mono truncate transition-colors ${
              active ? 'text-[#00FF66]' : 'group-hover:text-[#00FF66]'
            }`}
          >
            {label}
          </span>
          {alert && (
            <AlertTriangle className="w-3.5 h-3.5 text-[#FF0000] fill-[#FF0000] animate-pulse shrink-0" />
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          {extraBadge && (
            <span className="text-[7.5px] sm:text-[8px] font-mono opacity-50 uppercase tracking-wider hidden md:inline">
              {extraBadge}
            </span>
          )}
          {active ? (
            <span className="text-[8px] sm:text-[9px] font-mono font-black px-1.5 py-0.5 border border-[#00FF66] bg-[#00FF66] text-[#000000] uppercase tracking-wider flex items-center gap-1 shadow-[0_0_8px_rgba(0,255,102,0.5)]">
              <TrendingUp className="w-2.5 h-2.5 stroke-[2.5]" />
              GRAPHING
            </span>
          ) : onClick ? (
            <span className="text-[8px] sm:text-[8.5px] font-mono opacity-40 group-hover:opacity-100 group-hover:text-[#00FF66] transition-opacity uppercase tracking-wider">
              VIEW GRAPH
            </span>
          ) : null}
        </div>
      </div>

      {/* Primary Numerical Readout: Massive scaled-up typography (4rem - 5rem) */}
      <div className="telemetry-value-container flex items-baseline justify-start gap-2 my-auto w-full overflow-hidden leading-none py-1">
        <span
          className="telemetry-value telemetry-num font-norwester font-black tracking-tight leading-none transition-colors"
          style={{ color: activeColor }}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        <span className="telemetry-unit font-mono font-black uppercase tracking-wider">
          {unit}
        </span>
      </div>

      {/* Footer row: Channel active & Graph Status hint */}
      <div className="w-full flex items-center justify-between leading-none pt-1.5 border-t border-[#e2ece6]/10 shrink-0">
        <p className="text-[8px] sm:text-[8.5px] uppercase tracking-wider font-black flex items-center gap-1 text-[#00FF66] font-mono truncate">
          <span className="w-1.5 h-1.5 rounded-full bg-[#00FF66] animate-pulse shrink-0" />
          CH-LIVE
        </p>
        <span className="text-[7.5px] sm:text-[8px] font-mono opacity-60 uppercase truncate ml-1 text-right">
          {active ? 'CURRENTLY STREAMING' : 'CLICK TO GRAPH'}
        </span>
      </div>
    </div>
  );
}

