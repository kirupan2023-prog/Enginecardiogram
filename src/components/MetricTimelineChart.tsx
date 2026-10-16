import { useEffect, useRef } from 'react';
import { Chart, registerables, ChartConfiguration } from 'chart.js';
import { AlertTriangle, TrendingUp } from 'lucide-react';

Chart.register(...registerables);

interface MetricTimelineChartProps {
  label: string;
  data: number[];
  timestamps: string[];
  minY: number;
  maxY: number;
  unit: string;
  color?: string;
  alert: boolean;
  alertThreshold: number;
}

export default function MetricTimelineChart({
  label,
  data,
  timestamps,
  minY,
  maxY,
  unit,
  color,
  alert,
  alertThreshold,
}: MetricTimelineChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstanceRef = useRef<Chart | null>(null);
  const activeColor = '#e2ece6';
  const gridColor = 'rgba(226, 236, 230, 0.15)';

  useEffect(() => {
    if (!canvasRef.current) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const config: ChartConfiguration = {
      type: 'line',
      data: {
        labels: timestamps,
        datasets: [
          {
            label: label,
            data: data,
            borderColor: activeColor,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.15,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            enabled: true,
            backgroundColor: '#0d110f',
            titleColor: '#e2ece6',
            bodyColor: '#e2ece6',
            borderColor: '#e2ece6',
            borderWidth: 1,
            titleFont: { family: 'JetBrains Mono, monospace', size: 11 },
            bodyFont: { family: 'JetBrains Mono, monospace', size: 11 },
          },
        },
        scales: {
          x: {
            display: true,
            grid: {
              color: gridColor,
            },
            ticks: {
              color: activeColor,
              font: {
                family: 'JetBrains Mono, monospace',
                size: 9,
              },
              maxTicksLimit: 6,
            },
          },
          y: {
            type: 'linear',
            min: minY,
            max: maxY,
            grid: {
              color: gridColor,
            },
            ticks: {
              color: activeColor,
              font: {
                family: 'JetBrains Mono, monospace',
                size: 9,
              },
            },
          },
        },
        interaction: {
          intersect: false,
          mode: 'index',
        },
        animation: {
          duration: 0,
        },
      },
    };

    const chartInstance = new Chart(ctx, config);
    chartInstanceRef.current = chartInstance;

    const handleResize = () => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.resize();
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chartInstance.destroy();
      chartInstanceRef.current = null;
    };
  }, []);

  // Stream data and style updates without recreating chart instance
  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;

    chart.data.labels = timestamps;
    chart.data.datasets[0].label = label;
    chart.data.datasets[0].data = data;

    chart.data.datasets[0].borderColor = alert ? '#FF0000' : (color || activeColor);
    chart.data.datasets[0].borderWidth = alert ? 3 : 2;

    if (chart.options.scales?.x) {
      chart.options.scales.x.ticks = {
        ...chart.options.scales.x.ticks,
        color: activeColor,
      };
      chart.options.scales.x.grid = {
        ...chart.options.scales.x.grid,
        color: gridColor,
      };
    }
    if (chart.options.scales?.y) {
      chart.options.scales.y.min = minY;
      chart.options.scales.y.max = maxY;
      chart.options.scales.y.ticks = {
        ...chart.options.scales.y.ticks,
        color: activeColor,
      };
      chart.options.scales.y.grid = {
        ...chart.options.scales.y.grid,
        color: gridColor,
      };
    }

    if (canvasRef.current && canvasRef.current.clientWidth > 0 && chart.width === 0) {
      chart.resize();
    }

    chart.update('none');
  }, [timestamps, data, label, alert, color, activeColor, gridColor, minY, maxY]);

  return (
    <div
      className={`relative flex flex-col p-2.5 sm:p-4 rounded-none border-2 transition-all duration-300 w-full max-w-full overflow-hidden ${
        alert
          ? 'border-[#e2ece6] bg-[#0d110f]/40 text-[#e2ece6]'
          : 'border-[#e2ece6]/30 bg-[#0d110f]/40 hover:border-[#e2ece6] text-[#e2ece6]'
      }`}
    >
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-[#e2ece6]/20 opacity-90">
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" />
          <span className="text-sm tracking-widest uppercase">
            {label} HISTORY
          </span>
        </div>
        <div className="flex items-center gap-2">
          {alert && (
            <AlertTriangle className="w-5 h-5 text-[#FF0000] fill-[#FF0000] animate-pulse" />
          )}
          <span className="text-[11px] border border-[#e2ece6]/30 px-1.5 py-0.5 rounded-none font-mono">
            {unit}
          </span>
        </div>
      </div>
      
      <div className="relative h-44 w-full">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
