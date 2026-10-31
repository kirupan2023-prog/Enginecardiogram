export interface TelemetryData {
  rpm: number;       // RPM (0 - 9000)
  speed: number;     // Speed in MPH or km/h (0 - 180)
  temp: number;      // Engine Temp in °C or °F (0 - 130)
  throttle: number;  // Throttle position % (0 - 100)
  load: number;      // Engine Load % (0 - 100)
  gear: number;      // Gear (0 - 10, where 0 is Neutral)
  timestamp: string; // Formatting HH:mm:ss
  timestampMs: number;
  coolantTemp?: number; // Coolant / Engine Temp
}

export interface MetricThresholds {
  rpmWarning: number;
  rpmCritical: number;
  tempWarning: number;
  tempCritical: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'simulator';

export interface TelemetryHistory {
  rpm: number[];
  speed: number[];
  temp: number[];
  throttle: number[];
  load: number[];
  gear: number[];
  timestamps: string[];
}
