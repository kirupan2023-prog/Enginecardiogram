/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { db, ref, set, onValue } from './firebase';
import { 
  Gauge, 
  Compass, 
  Thermometer, 
  Zap, 
  Cpu, 
  Play, 
  Square, 
  Settings, 
  AlertTriangle, 
  RefreshCw, 
  Sliders, 
  Download, 
  Terminal, 
  Info,
  Check,
  Power,
  ChevronDown,
  ChevronUp,
  SlidersHorizontal,
  ExternalLink,
  Sun,
  Moon,
  Truck,
  Radio,
  ShieldAlert,
  TrendingUp,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ConnectionStatus, TelemetryData, TelemetryHistory, MetricThresholds } from './types';
import DigitalCard from './components/DigitalCard';
import MetricTimelineChart from './components/MetricTimelineChart';
import ArduinoGuide from './components/ArduinoGuide';
import { TRUCK_PROFILES, TruckProfile } from './truckProfiles';
import mqtt from 'mqtt';

declare global {
  interface Window {
    mqtt?: any;
    executeCrashProtocol?: (cause: string) => void;
    triggerVehicleImpactCrash?: (cause: string) => void;
    triggerMalfunctionEscalation?: (sensorLabel: string, details: string, durationStr?: string) => void;
    evaluateTelemetryMalfunction?: (rawSpeed: number, rawTemp: number, rawThrottle: number, parsedLoad: number) => void;
    analyzeTelemetryForCrash?: (speed: number | string) => boolean;
    lockdownUI?: (causeOrConfig: any, lat?: any, lon?: any) => void;
    triggerTestTempAnomaly?: () => void;
    triggerTestSpeedAnomaly?: () => void;
    triggerTestThrottleAnomaly?: () => void;
    triggerTestLoadAnomaly?: () => void;
    triggerClearFault?: () => void;
    triggerFastForward60s?: () => void;
    switchTab?: (targetView: string) => void;
  }
}

const STANDARD_BAUD_RATES = [9600, 19200, 38400, 57600, 115200];
const HISTORY_CAPACITY_OPTIONS = [50, 100, 150, 200, 300];

export type DashboardView = 'dashboard' | 'graphs' | 'telematics' | 'controls';

// Safe Firebase RTDB helper that never throws or crashes if Firebase is unavailable
const safeFirebaseSet = (path: string, payload: any) => {
  try {
    if (!db || typeof ref !== 'function' || typeof set !== 'function') return;
    const pathRef = ref(db, path);
    set(pathRef, payload).catch((err: any) => {
      console.warn(`[Firebase RTDB] Write error on ${path}:`, err?.message || err);
    });
  } catch (err: any) {
    console.warn(`[Firebase RTDB] Invocation error on ${path}:`, err?.message || err);
  }
};

export default function App() {
  // Tab Navigation View State: 4 distinct views
  const [activeTab, setActiveTab] = useState<DashboardView>('dashboard');

  // 5 Active Dashboard Telemetry Metrics (ENGINE SPEED, VEHICLE SPEED, COOLANT TEMP, THROTTLE POS, ENGINE LOAD)
  // Dedicated Lower Graph Stage active metric (defaults to 'rpm')
  const [selectedDashboardMetric, setSelectedDashboardMetric] = useState<'rpm' | 'speed' | 'temp' | 'throttle' | 'load'>('rpm');

  // Interactive Click-to-Graph selection handler
  const handleSelectMetric = (metric: 'rpm' | 'speed' | 'temp' | 'throttle' | 'load') => {
    setSelectedDashboardMetric(metric);
  };

  // 4. JavaScript Navigation Logic for Left Ribbon Views
  const switchTab = (targetView: DashboardView | string) => {
    let tabName: DashboardView = 'dashboard';
    if (targetView.includes('graph')) tabName = 'graphs';
    else if (targetView.includes('telemat')) tabName = 'telematics';
    else if (targetView.includes('control')) tabName = 'controls';
    else tabName = 'dashboard';

    setActiveTab(tabName);

    // Toggles the display property of all 4 view containers directly in DOM
    const viewNames: DashboardView[] = ['dashboard', 'graphs', 'telematics', 'controls'];
    viewNames.forEach(viewId => {
      const container = document.getElementById(`view-${viewId}`);
      if (container) {
        container.style.display = viewId === tabName ? 'block' : 'none';
      }
    });

    // Trigger window resize event so Chart.js recalculates layout upon unhiding graphs
    if (tabName === 'graphs') {
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 60);
    }
  };

  useEffect(() => {
    (window as any).switchTab = switchTab;
  }, []);

  // Vehicle Profile State
  const [selectedTruckId, setSelectedTruckId] = useState<'class8' | 'medium' | 'light'>('class8');
  const activeTruck = TRUCK_PROFILES[selectedTruckId] || TRUCK_PROFILES.class8;
  const truckRef = useRef<TruckProfile>(activeTruck);

  useEffect(() => {
    truckRef.current = activeTruck;
  }, [activeTruck]);

  // Telemetry state - Defaults to 0 when disconnected / unlinked
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    rpm: 0,
    speed: 0,
    temp: 0,
    coolantTemp: 0,
    throttle: 0,
    load: 0,
    gear: 0,
    timestamp: '--:--:--',
    timestampMs: 0
  });

  // Historic rolling buffer state
  const [history, setHistory] = useState<TelemetryHistory>({
    rpm: [0],
    speed: [0],
    temp: [0],
    throttle: [0],
    load: [0],
    gear: [0],
    timestamps: ['--:--:--']
  });

  // Session stats tracking
  const [stats, setStats] = useState({
    rpm: { min: null, max: null, sum: 0, count: 0 },
    speed: { min: null, max: null, sum: 0, count: 0 },
    temp: { min: null, max: null, sum: 0, count: 0 },
    throttle: { min: null, max: null, sum: 0, count: 0 },
    load: { min: null, max: null, sum: 0, count: 0 },
    gear: { min: null, max: null, sum: 0, count: 0 },
  });

  // Settings & Connection Status
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const connectionStatusRef = useRef<ConnectionStatus>('disconnected');
  const isLiveRemoteRef = useRef<boolean>(false);

  // Connection and Simulator active state
  const isConnected = connectionStatus === 'connected';
  const isSimulator = connectionStatus === 'simulator';

  // Whenever isConnected is false and the simulator mode is inactive,
  // all telemetry state variables (speed, rpm, coolantTemp, throttle, load) automatically default to 0
  // instead of holding onto stale data when disconnected.
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
    if (!isConnected && !isSimulator) {
      if (!isLiveRemoteRef.current) {
        setTelemetry({
          rpm: 0,
          speed: 0,
          temp: 0,
          coolantTemp: 0,
          throttle: 0,
          load: 0,
          gear: 0,
          timestamp: '--:--:--',
          timestampMs: 0
        });
      }
      if (activeMalfunctionRef.current) {
        activeMalfunctionRef.current = null;
        setActiveMalfunction(null);
        setMalfunctionStopwatch('00:00');
      }
    }
  }, [connectionStatus, isConnected, isSimulator]);

  const [baudRate, setBaudRate] = useState<number>(115200);
  const [historyCapacity, setHistoryCapacity] = useState<number>(100);
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>('C');
  const [speedUnit, setSpeedUnit] = useState<'MPH' | 'KMH'>('KMH');
  const [autoScaleY, setAutoScaleY] = useState<boolean>(false);
  const [simProfile, setSimProfile] = useState<'track' | 'drag' | 'cruise' | 'overheat'>('cruise');
  const [simHz, setSimHz] = useState<number>(10);
  const [isSimMenuOpen, setIsSimMenuOpen] = useState<boolean>(false);
  const simDropdownRef = useRef<HTMLDivElement>(null);

  // Close simulation settings dropdown on outside click or Escape key
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (simDropdownRef.current && !simDropdownRef.current.contains(event.target as Node)) {
        setIsSimMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSimMenuOpen(false);
      }
    };
    if (isSimMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSimMenuOpen]);
  
  // Theme state (dark or light)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('ecg-theme');
    return (saved === 'light' || saved === 'dark') ? saved : 'dark';
  });

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('theme-light');
    } else {
      document.documentElement.classList.remove('theme-light');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('ecg-theme', next);
      return next;
    });
  };
  
  // Console Logging
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [isConsoleOpen, setIsConsoleOpen] = useState<boolean>(false);
  const [isConsoleActive, setIsConsoleActive] = useState<boolean>(true);
  const [logFilter, setLogFilter] = useState<'all' | 'data' | 'system'>('all');
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);
  const [errorAlert, setErrorAlert] = useState<{ message: string; isPermission: boolean } | null>(null);

  // Connection Performance
  const [dataHz, setDataHz] = useState<number>(0);
  
  // Handle Vehicle Profile switching
  const handleProfileChange = (newProfileId: 'class8' | 'medium' | 'light') => {
    setSelectedTruckId(newProfileId);
    const newTruck = TRUCK_PROFILES[newProfileId];
    truckRef.current = newTruck;
    addLog(`Fleet Profile active: ${newTruck.name} (${newTruck.model}) [Redline: ${newTruck.redlineRpm} RPM, Max Speed: ${newTruck.maxSpeedKmh} km/h]`);
  };

  // Dynamic Safety Thresholds based on selected vehicle
  const thresholds: MetricThresholds = {
    rpmWarning: activeTruck.rpmWarning,
    rpmCritical: activeTruck.redlineRpm,
    tempWarning: 95,
    tempCritical: 115
  };

  // SOS Protocol & MQTT Cloud Bridge State & Refs
  const SOS_TOPIC = 'ecg/fleet/truck04/sos';
  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081'
  ];
  const [activeBrokerUrl, setActiveBrokerUrl] = useState<string>(MQTT_BROKERS[0]);
  const speedHistoryRef = useRef<number[]>([]);
  const crashTriggeredRef = useRef<boolean>(false);
  const mqttClientRef = useRef<any>(null);
  const clientIdRef = useRef<string>('ecg_truck04_' + Math.random().toString(16).substring(2, 9));
  const [mqttStatus, setMqttStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('connecting');

  // Telemetry Anomaly Detection & Inline Malfunction Banner State & Refs
  interface ActiveMalfunctionState {
    sensorKey: 'speed' | 'temp' | 'throttle' | 'load';
    sensorLabel: string;
    headline: string;
    details: string;
    startTime: number;
  }

  const [activeMalfunction, setActiveMalfunction] = useState<ActiveMalfunctionState | null>(null);
  const [malfunctionStopwatch, setMalfunctionStopwatch] = useState<string>('00:00');
  const activeMalfunctionRef = useRef<ActiveMalfunctionState | null>(null);
  const prevSpeedRef = useRef<number>(0);

  // Full-Screen SOS Lockdown UI Generator
  // Supports both Physical Crash Impact ("VEHICLE IMPACT DETECTED")
  // and 60-Second Telemetry Escalation ("CRITICAL SYSTEM TELEMETRY MALFUNCTION DETECTED")
  interface LockdownConfig {
    mode?: 'crash' | 'malfunction';
    headline?: string;
    cause?: string;
    sensorLabel?: string;
    details?: string;
    duration?: string;
    lat?: any;
    lon?: any;
  }

  const lockdownUI = (
    causeOrConfig: string | LockdownConfig,
    latParam?: any,
    lonParam?: any
  ) => {
    crashTriggeredRef.current = true;

    const isMalfunction = typeof causeOrConfig === 'object'
      ? causeOrConfig.mode === 'malfunction'
      : (causeOrConfig.includes('MALFUNCTION') || causeOrConfig.includes('SAFETY ESCALATION'));

    const headline = isMalfunction
      ? 'EMERGENCY SYSTEM MALFUNCTION'
      : 'EMERGENCY CRASH SOS';

    const subtitle = isMalfunction
      ? 'CONTINUOUS SENSOR ANOMALY EXCEEDED 60s SAFETY THRESHOLD'
      : 'VEHICLE COLLISION DETECTED • LIVE GPS DISPATCH ACTIVATED';

    const cause = typeof causeOrConfig === 'string'
      ? causeOrConfig
      : (causeOrConfig.cause || (isMalfunction ? 'TELEMETRY SENSOR MALFUNCTION' : 'PHYSICAL COLLISION DETECTED'));

    const sensorLabel = typeof causeOrConfig === 'object' && causeOrConfig.sensorLabel
      ? causeOrConfig.sensorLabel
      : (isMalfunction ? 'TELEMETRY SENSOR' : '');

    const details = typeof causeOrConfig === 'object' && causeOrConfig.details
      ? causeOrConfig.details
      : '';

    const durationStr = typeof causeOrConfig === 'object' && causeOrConfig.duration
      ? causeOrConfig.duration
      : '00:10';

    const lat = typeof causeOrConfig === 'object' && causeOrConfig.lat !== undefined ? causeOrConfig.lat : latParam;
    const lon = typeof causeOrConfig === 'object' && causeOrConfig.lon !== undefined ? causeOrConfig.lon : lonParam;

    let latStr = 'N/A';
    let lonStr = 'N/A';
    if (lat !== undefined && lat !== null) {
      latStr = typeof lat === 'number' ? lat.toFixed(6) : String(lat);
    }
    if (lon !== undefined && lon !== null) {
      lonStr = typeof lon === 'number' ? lon.toFixed(6) : String(lon);
    }

    const now = new Date();
    const timeFormatted = `${now.toLocaleDateString()} ${now.toLocaleTimeString()} (${now.toISOString()})`;

    const targetElement = document.getElementById('root') || document.body;
    targetElement.innerHTML = `
      <div id="sos-lockdown-screen" style="
        background-color: #FF0000;
        color: white;
        min-height: 100vh;
        width: 100vw;
        position: fixed;
        inset: 0;
        z-index: 99999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: clamp(20px, 4vw, 48px);
        box-sizing: border-box;
        font-family: 'JetBrains Mono', 'Courier New', Courier, monospace;
        text-align: center;
        overflow-y: auto;
      ">
        <div style="
          max-width: 860px;
          width: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          margin: auto 0;
        ">
          <!-- Prominent Yellow Triangle Warning Sign -->
          <div style="
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 20px;
          ">
            <svg width="90" height="90" viewBox="0 0 24 24" fill="none" style="filter: drop-shadow(0 4px 16px rgba(0,0,0,0.4));">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" fill="#FFCC00" stroke="#FFCC00" stroke-width="1.5" stroke-linejoin="round" />
              <line x1="12" y1="9" x2="12" y2="13" stroke="#000000" stroke-width="2.6" stroke-linecap="round" />
              <circle cx="12" cy="17" r="1.3" fill="#000000" />
            </svg>
          </div>

          <!-- Massive Centered Headline -->
          <h1 style="
            font-size: clamp(26px, 4.4vw, 54px);
            font-weight: 900;
            letter-spacing: clamp(1px, 0.4vw, 4px);
            margin: 0 0 12px 0;
            text-transform: uppercase;
            line-height: 1.15;
            color: #FFFFFF;
            text-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
          ">
            ${headline}
          </h1>

          <p style="
            font-size: clamp(12px, 1.5vw, 15px);
            letter-spacing: 2px;
            font-weight: 800;
            margin: 0 0 28px 0;
            color: #FFFFFF;
            opacity: 0.95;
            text-transform: uppercase;
          ">
            ${subtitle}
          </p>

          <!-- Cause and telemetry details card -->
          <div style="
            width: 100%;
            max-width: 680px;
            text-align: left;
            margin-bottom: 34px;
            background: rgba(0, 0, 0, 0.28);
            padding: 24px 28px;
            border-radius: 4px;
            box-sizing: border-box;
            border: 1px solid rgba(255, 255, 255, 0.2);
          ">
            ${isMalfunction ? `
              <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.25); padding-bottom: 12px; margin-bottom: 14px;">
                <div style="font-size: 11px; letter-spacing: 2px; color: #FFCC00; text-transform: uppercase; font-weight: 800;">
                  Faulty Sensor Parameter:
                </div>
                <div style="font-size: clamp(17px, 2.2vw, 22px); font-weight: 900; color: #FFFFFF; margin-top: 4px;">
                  ${sensorLabel}
                </div>
                ${details ? `
                  <div style="font-size: 13px; color: #FFFFFF; margin-top: 4px; opacity: 0.95; font-weight: 600;">
                    ${details}
                  </div>
                ` : ''}
              </div>

              <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.25); padding-bottom: 12px; margin-bottom: 14px;">
                <div style="font-size: 11px; letter-spacing: 2px; color: #FFCC00; text-transform: uppercase; font-weight: 800;">
                  Safety Escalation Status:
                </div>
                <div style="font-size: clamp(14px, 1.8vw, 17px); font-weight: 900; color: #FFCC00; margin-top: 4px;">
                  CONTINUOUS SENSOR ANOMALY EXCEEDED 10s SAFETY THRESHOLD
                </div>
                <div style="font-size: 12px; color: #FFFFFF; margin-top: 4px; opacity: 0.9;">
                  Active Sensor Malfunction Duration: <strong>${durationStr}</strong> (Safety Threshold: 10s)
                </div>
              </div>
            ` : `
              <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.25); padding-bottom: 12px; margin-bottom: 14px;">
                <div style="font-size: 11px; letter-spacing: 2px; color: #FFCC00; text-transform: uppercase; font-weight: 800;">
                  Impact Event Cause:
                </div>
                <div style="font-size: clamp(17px, 2.2vw, 22px); font-weight: 900; color: #FFFFFF; margin-top: 4px;">
                  ${cause}
                </div>
              </div>
            `}

            <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.25); padding-bottom: 12px; margin-bottom: 14px;">
              <div style="font-size: 11px; letter-spacing: 2px; color: rgba(255, 255, 255, 0.85); text-transform: uppercase; font-weight: 700;">
                Live Geolocation Coordinates:
              </div>
              <div style="font-size: clamp(14px, 1.8vw, 17px); font-weight: 800; color: #FFFFFF; margin-top: 4px;">
                LATITUDE: <span id="sos-live-lat" style="color: #FFCC00;">${latStr}</span> &nbsp;|&nbsp; LONGITUDE: <span id="sos-live-lon" style="color: #FFCC00;">${lonStr}</span>
              </div>
              <div id="sos-live-maps-link" style="margin-top: 6px;">
                ${(latStr !== 'N/A' && latStr !== 'Acquiring GPS...' && latStr !== 'Acquiring live GPS fix...' && latStr !== 'Unavailable' && latStr !== 'Not Supported') ? `
                  <a href="https://maps.google.com/?q=${latStr},${lonStr}" target="_blank" rel="noopener noreferrer" style="color: #FFFFFF; font-size: 12px; text-decoration: underline; font-weight: 700;">
                    Open Vehicle Location on Google Maps ↗
                  </a>
                ` : `
                  <span style="font-size: 11px; color: rgba(255,255,255,0.85); font-style: italic;">
                    Fetching browser navigator.geolocation satellite position...
                  </span>
                `}
              </div>
            </div>

            <div style="border-bottom: 1px solid rgba(255, 255, 255, 0.25); padding-bottom: 12px; margin-bottom: 14px;">
              <div style="font-size: 11px; letter-spacing: 2px; color: rgba(255, 255, 255, 0.85); text-transform: uppercase; font-weight: 700;">
                Timestamp:
              </div>
              <div style="font-size: 13px; color: #FFFFFF; margin-top: 4px; opacity: 0.95;">
                ${timeFormatted}
              </div>
            </div>

            <div>
              <div style="font-size: 11px; letter-spacing: 2px; color: rgba(255, 255, 255, 0.85); text-transform: uppercase; font-weight: 700;">
                MQTT Topic Broadcast:
              </div>
              <div style="font-size: 13px; color: #FFFFFF; font-weight: 700; margin-top: 4px;">
                ✓ Dispatched to ${activeBrokerUrl} [${SOS_TOPIC}]
              </div>
            </div>
          </div>

          <!-- Reset Button -->
          <button
            id="reset-system-btn"
            onclick="window.location.reload()"
            style="
              background-color: #FFFFFF;
              color: #FF0000;
              border: none;
              padding: 16px 42px;
              font-size: 16px;
              font-weight: 900;
              letter-spacing: 4px;
              text-transform: uppercase;
              cursor: pointer;
              font-family: inherit;
              box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
              transition: all 0.2s ease;
            "
            onmouseover="this.style.backgroundColor='#000000'; this.style.color='#FFFFFF';"
            onmouseout="this.style.backgroundColor='#FFFFFF'; this.style.color='#FF0000';"
          >
            RESET SYSTEM
          </button>
        </div>
      </div>
    `;

    // Automatically fetch live browser geolocation coordinates and update screen
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const latEl = document.getElementById('sos-live-lat');
          const lonEl = document.getElementById('sos-live-lon');
          const mapEl = document.getElementById('sos-live-maps-link');
          const formattedLat = pos.coords.latitude.toFixed(6);
          const formattedLon = pos.coords.longitude.toFixed(6);
          if (latEl) latEl.textContent = formattedLat;
          if (lonEl) lonEl.textContent = formattedLon;
          if (mapEl) {
            mapEl.innerHTML = `
              <a href="https://maps.google.com/?q=${formattedLat},${formattedLon}" target="_blank" rel="noopener noreferrer" style="color: #FFFFFF; font-size: 12px; text-decoration: underline; font-weight: 700;">
                Open Vehicle Location on Google Maps (${formattedLat}, ${formattedLon}) ↗
              </a>
            `;
          }
        },
        (err) => {
          console.warn('Navigator geolocation request error:', err.message);
        },
        { timeout: 6000, enableHighAccuracy: true }
      );
    }

    // Wire up Reset button to clear Firebase RTDB vehicle/sos flag and dismiss overlay
    setTimeout(() => {
      const resetBtn = document.getElementById('reset-system-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', (e) => {
          e.preventDefault();
          safeFirebaseSet('vehicle/sos', false);
          const overlay = document.getElementById('crash-overlay');
          if (overlay) overlay.remove();
          crashTriggeredRef.current = false;
        });
      }
    }, 100);
  };

  // Cloud MQTT Alert Transmission Helper
  const broadcastEmergencyMqtt = (
    mode: 'crash' | 'malfunction',
    cause: string,
    extra?: any
  ) => {
    const dispatchPayload = (lat: any, lon: any) => {
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: mode,
        headline: mode === 'malfunction'
          ? 'CRITICAL SYSTEM TELEMETRY MALFUNCTION DETECTED'
          : 'VEHICLE IMPACT DETECTED',
        cause: cause,
        extra: extra,
        location: lat !== null ? { latitude: lat, longitude: lon } : null,
        senderId: clientIdRef.current,
        vehicle: truckRef.current?.name
      });

      if (mqttClientRef.current) {
        try {
          mqttClientRef.current.publish(SOS_TOPIC, payload, { qos: 1 });
          addLog(`Dispatched ${mode.toUpperCase()} alert to MQTT topic: ${SOS_TOPIC}`);
        } catch (err) {
          console.error('MQTT publish error:', err);
        }
      }
    };

    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          dispatchPayload(pos.coords.latitude, pos.coords.longitude);
          lockdownUI({
            mode,
            cause,
            sensorLabel: extra?.sensorLabel,
            details: extra?.details,
            duration: extra?.duration,
            lat: pos.coords.latitude,
            lon: pos.coords.longitude
          });
        },
        (err) => {
          dispatchPayload(null, null);
          lockdownUI({
            mode,
            cause,
            sensorLabel: extra?.sensorLabel,
            details: extra?.details,
            duration: extra?.duration,
            lat: 'Unavailable',
            lon: 'Unavailable'
          });
        },
        { timeout: 4000, enableHighAccuracy: true }
      );
    } else {
      dispatchPayload(null, null);
      lockdownUI({
        mode,
        cause,
        sensorLabel: extra?.sensorLabel,
        details: extra?.details,
        duration: extra?.duration,
        lat: 'Not Supported',
        lon: 'Not Supported'
      });
    }
  };

  // 1. Accelerometer-Only Crash Detection Trigger
  // The full-screen "EMERGENCY CRASH SOS" Lockdown must strictly be triggered by mobile accelerometer motion
  const triggerVehicleImpactCrash = (cause: string) => {
    if (crashTriggeredRef.current) return;
    crashTriggeredRef.current = true;

    addLog(`💥 [ACCELEROMETER COLLISION] ${cause} — Launching full-screen EMERGENCY CRASH SOS lockdown`, 'system');

    // Trigger full-screen lockdown UI immediately
    lockdownUI({
      mode: 'crash',
      cause: cause
    }, 'Acquiring live GPS fix...', 'Acquiring live GPS fix...');

    // Transmit MQTT SOS payload with GPS coordinates to cloud broker
    broadcastEmergencyMqtt('crash', cause);
  };

  // Backward compatibility alias for executeCrashProtocol
  const executeCrashProtocol = (cause: string) => {
    triggerVehicleImpactCrash(cause);
  };

  // 3. 10-Second Malfunction SOS Escalation Protocol Trigger
  // If any single sensor malfunction persists continuously for more than 10 seconds (stopwatch reaches 00:10):
  // 1. Trigger full-screen Lockdown SOS alert screen.
  // 2. Headline MUST state "CRITICAL SYSTEM TELEMETRY MALFUNCTION DETECTED" (NOT a crash or impact alert).
  // 3. Display details of specific faulty parameter and state: "CONTINUOUS SENSOR ANOMALY EXCEEDED 10s SAFETY THRESHOLD".
  const triggerMalfunctionEscalation = (
    sensorLabel: string,
    details: string,
    durationStr: string = '00:10'
  ) => {
    if (crashTriggeredRef.current) return;
    crashTriggeredRef.current = true;

    const causeMsg = `${sensorLabel} MALFUNCTION: CONTINUOUS SENSOR ANOMALY EXCEEDED 10s SAFETY THRESHOLD`;
    addLog(`🚨 [10-SECOND SAFETY ESCALATION] ${causeMsg}`, 'system');

    lockdownUI({
      mode: 'malfunction',
      cause: causeMsg,
      sensorLabel: sensorLabel,
      details: details,
      duration: durationStr
    }, 'Acquiring GPS...', 'Acquiring GPS...');

    broadcastEmergencyMqtt('malfunction', causeMsg, {
      sensorLabel,
      details,
      duration: durationStr,
      status: 'CONTINUOUS SENSOR ANOMALY EXCEEDED 10s SAFETY THRESHOLD'
    });
  };

  // 2. Telemetry Anomaly Detection & Inline Malfunction Banner Logic
  // Out-of-bounds anomaly rules for incoming Web Serial telemetry:
  // - Vehicle Speed: Instant drop to 0 KM/H while Engine Load > 20%
  // - Coolant Temp: Reading >= 120 °C
  // - Throttle Position: Reading < 0% or > 100%
  // - Engine Load: Reading >= 98%
  // When an anomaly is detected, DO NOT pop up a full-screen alert.
  // Instead, display warning status banner on top of the dashboard specifying faulty sensor with live MM:SS stopwatch.
  // If jumper wire is removed (data returns to normal limits), automatically clear banner and reset stopwatch.
  const evaluateTelemetryMalfunction = (
    rawSpeed: number,
    rawTemp: number,
    rawThrottle: number,
    parsedLoad: number,
    forceOrRemote: boolean = false
  ) => {
    if (crashTriggeredRef.current) return;

    // Ensure sensor malfunction timer only starts after a valid USB serial connection or simulation is actively running
    const isLocalRunning = connectionStatusRef.current === 'connected' || connectionStatusRef.current === 'simulator';
    if (!isLocalRunning && !forceOrRemote) {
      if (activeMalfunctionRef.current) {
        activeMalfunctionRef.current = null;
        setActiveMalfunction(null);
        setMalfunctionStopwatch('00:00');
      }
      return;
    }

    const speed = isNaN(rawSpeed) ? 0 : rawSpeed;
    const temp = isNaN(rawTemp) ? 0 : rawTemp;
    const throttle = isNaN(rawThrottle) ? 0 : rawThrottle;
    const load = isNaN(parsedLoad) ? 0 : parsedLoad;

    // Rule 1: Vehicle Speed - Instant drop to 0 KM/H while Engine Load > 20%
    const isSpeedFault = (speed <= 0) && (load > 20);

    // Rule 2: Coolant Temp - Reading >= 120 °C
    const isTempFault = temp >= 120;

    // Rule 3: Throttle Position - Reading < 0% or > 100%
    const isThrottleFault = throttle < 0 || throttle > 100;

    // Rule 4: Engine Load - Reading >= 98%
    const isLoadFault = load >= 98;

    let activeFault: {
      sensorKey: 'speed' | 'temp' | 'throttle' | 'load';
      sensorLabel: string;
      headline: string;
      details: string;
    } | null = null;

    if (isTempFault) {
      activeFault = {
        sensorKey: 'temp',
        sensorLabel: 'COOLANT TEMP SENSOR',
        headline: '⚠️ COOLANT TEMP SENSOR MALFUNCTION DETECTED',
        details: `Coolant Temp reading ${temp.toFixed(1)} °C exceeds 120 °C safety limit`
      };
    } else if (isSpeedFault) {
      activeFault = {
        sensorKey: 'speed',
        sensorLabel: 'VEHICLE SPEED SENSOR',
        headline: '⚠️ VEHICLE SPEED SENSOR MALFUNCTION DETECTED',
        details: `Vehicle Speed 0 KM/H while Engine Load is ${load.toFixed(0)}% (> 20%)`
      };
    } else if (isThrottleFault) {
      activeFault = {
        sensorKey: 'throttle',
        sensorLabel: 'THROTTLE POSITION SENSOR',
        headline: '⚠️ THROTTLE POSITION SENSOR MALFUNCTION DETECTED',
        details: `Throttle Position reading ${throttle.toFixed(1)}% out of bounds (< 0% or > 100%)`
      };
    } else if (isLoadFault) {
      activeFault = {
        sensorKey: 'load',
        sensorLabel: 'ENGINE LOAD SENSOR',
        headline: '⚠️ ENGINE LOAD SENSOR MALFUNCTION DETECTED',
        details: `Engine Load reading ${load.toFixed(1)}% exceeds 98% threshold`
      };
    }

    if (activeFault) {
      if (!activeMalfunctionRef.current) {
        // First occurrence: initiate stopwatch from 00:00
        const newMalfunction: ActiveMalfunctionState = {
          ...activeFault,
          startTime: Date.now()
        };
        activeMalfunctionRef.current = newMalfunction;
        setActiveMalfunction(newMalfunction);
        setMalfunctionStopwatch('00:00');
        addLog(`⚠️ [SENSOR MALFUNCTION DETECTED] ${activeFault.headline}: ${activeFault.details}`, 'system');
      } else {
        // Anomaly is continuously active: preserve startTime so stopwatch and 60s escalation continue
        activeMalfunctionRef.current.details = activeFault.details;
        activeMalfunctionRef.current.headline = activeFault.headline;
        activeMalfunctionRef.current.sensorLabel = activeFault.sensorLabel;
      }
    } else {
      // Normal limits restored (jumper wire removed)
      if (activeMalfunctionRef.current) {
        addLog('✓ [MALFUNCTION CLEARED] Sensor data returned to normal limits. Jumper wire removed; malfunction banner cleared & stopwatch reset.', 'system');
        activeMalfunctionRef.current = null;
        setActiveMalfunction(null);
        setMalfunctionStopwatch('00:00');
      }
    }

    prevSpeedRef.current = speed;
  };

  // Stopwatch Timer Effect for Active Sensor Malfunction
  useEffect(() => {
    if (activeMalfunction) {
      const updateStopwatch = () => {
        const isLocalRunning = connectionStatus === 'connected' || connectionStatus === 'simulator';
        if (!isLocalRunning && !isLiveRemoteRef.current) {
          activeMalfunctionRef.current = null;
          setActiveMalfunction(null);
          setMalfunctionStopwatch('00:00');
          return;
        }

        if (!activeMalfunctionRef.current) return;
        const elapsedSec = Math.floor((Date.now() - activeMalfunctionRef.current.startTime) / 1000);
        const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const ss = String(elapsedSec % 60).padStart(2, '0');
        const formatted = `${mm}:${ss}`;
        setMalfunctionStopwatch(formatted);

        // Check 10-second escalation threshold (stopwatch reaches 00:10)
        if (elapsedSec >= 10 && !crashTriggeredRef.current) {
          triggerMalfunctionEscalation(
            activeMalfunctionRef.current.sensorLabel,
            activeMalfunctionRef.current.details,
            formatted
          );
        }
      };

      updateStopwatch();
      const timer = setInterval(updateStopwatch, 250);
      return () => clearInterval(timer);
    } else {
      setMalfunctionStopwatch('00:00');
    }
  }, [activeMalfunction, connectionStatus]);

  // Deprecated telemetry crash helper stub (telemetry drops now handled strictly as sensor malfunctions)
  const analyzeTelemetryForCrash = (_rawVehicleSpeedKmh: number | string): boolean => {
    return false;
  };

  // 2. Firebase Realtime Database Cross-Device Synchronization ('vehicle/sos')
  useEffect(() => {
    try {
      if (!db || typeof ref !== 'function' || typeof onValue !== 'function') {
        console.warn('[Firebase RTDB] Database not initialized, skipping vehicle/sos listener');
        return;
      }
      const sosRef = ref(db, 'vehicle/sos');
      let isFirstSosSync = true;
      let lastSosVal: boolean | null = null;

      const unsubscribe = onValue(
        sosRef,
        (snapshot) => {
          try {
            // Guard: ensure snapshot exists and is not null/empty
            if (!snapshot.exists()) {
              console.log('[Firebase RTDB] vehicle/sos node does not exist, ignoring');
              return;
            }

            const rawVal = snapshot.val();
            const isSosActive = rawVal === true;
            console.log('[Firebase RTDB] vehicle/sos snapshot received:', rawVal, '(initialSync:', isFirstSosSync, ')');

            // Prevent false SOS on page load:
            // The initial onValue callback fires immediately with current DB state upon connection.
            // Do NOT trigger crash lockdown on page load, even if the database held true from an old session.
            if (isFirstSosSync) {
              isFirstSosSync = false;
              lastSosVal = isSosActive;
              if (isSosActive) {
                console.log('[Firebase RTDB] Ignoring stale active SOS state on page mount');
              }
              return;
            }

            // Only trigger UI changes when the incoming value is explicitly true and genuinely changes from false/null to true
            if (isSosActive && lastSosVal !== true) {
              lastSosVal = true;
              if (!crashTriggeredRef.current) {
                triggerVehicleImpactCrash(
                  'REMOTE VEHICLE SOS TRIGGERED VIA FIREBASE REALTIME DATABASE'
                );
              }
            } else if (!isSosActive) {
              lastSosVal = false;
              // If reset remotely to false, dismiss overlay
              const overlay = document.getElementById('crash-overlay');
              if (overlay) overlay.remove();
              crashTriggeredRef.current = false;
            }
          } catch (valErr) {
            console.warn('[Firebase RTDB] snapshot val error:', valErr);
          }
        },
        (error) => {
          console.warn('[Firebase RTDB] vehicle/sos listener error:', error);
        }
      );

      return () => {
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      };
    } catch (err) {
      console.warn('[Firebase RTDB] Initialization error:', err);
    }
  }, []);

  // 2b. Firebase Realtime Database Telemetry Cloud Mirroring (Phone <- Firebase <- Laptop)
  // Ensure receiving end (mobile phone) listens to vehicle/telemetry and updates local UI state
  useEffect(() => {
    try {
      if (!db || typeof ref !== 'function' || typeof onValue !== 'function') {
        return;
      }
      const telemetryRef = ref(db, 'vehicle/telemetry');
      let isFirstTelemetrySync = true;

      const unsubscribe = onValue(
        telemetryRef,
        (snapshot) => {
          try {
            // Guard: ensure snapshot exists and has data
            if (!snapshot.exists()) return;
            const remoteData = snapshot.val();
            if (!remoteData || typeof remoteData !== 'object') return;

            // If this device is actively reading its own local physical serial port, don't overwrite local serial stream
            if (portRef.current) return;

            const rawSpeed = typeof remoteData.speed === 'number' ? remoteData.speed : parseFloat(remoteData.speed || 0);
            const rawRpm = typeof remoteData.rpm === 'number' ? remoteData.rpm : parseFloat(remoteData.rpm || 0);
            const rawTemp = typeof remoteData.coolantTemp === 'number'
              ? remoteData.coolantTemp
              : typeof remoteData.temp === 'number'
              ? remoteData.temp
              : parseFloat(remoteData.coolantTemp || remoteData.temp || 0);
            const rawThrottle = typeof remoteData.throttle === 'number' ? remoteData.throttle : parseFloat(remoteData.throttle ?? 42);
            const rawLoad = typeof remoteData.load === 'number' ? remoteData.load : parseFloat(remoteData.load ?? 38);

            if (isNaN(rawSpeed) || isNaN(rawRpm) || isNaN(rawTemp)) return;

            const nowMs = Date.now();
            const packetTime = typeof remoteData.timestamp === 'number' ? remoteData.timestamp : nowMs;
            const isFreshStream = (nowMs - packetTime) < 8000;

            // Prevent false sensor malfunction triggers on page load:
            // Initial connection callback should mirror metrics to UI, but NEVER evaluate a malfunction on load
            if (isFirstTelemetrySync) {
              isFirstTelemetrySync = false;
              console.log('[Firebase RTDB RX] Initial telemetry snapshot loaded on mount:', remoteData);
              const initialTimeStr = new Date(packetTime).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
              setTelemetry({
                rpm: rawRpm,
                speed: rawSpeed,
                temp: rawTemp,
                coolantTemp: rawTemp,
                throttle: rawThrottle,
                load: rawLoad,
                gear: 1,
                timestamp: initialTimeStr,
                timestampMs: packetTime
              });
              return;
            }

            console.log('[Firebase RTDB RX] Phone received vehicle/telemetry sync:', remoteData);

            // Only run malfunction evaluation when a genuine live stream is actively transmitting
            if (isFreshStream) {
              isLiveRemoteRef.current = true;
              evaluateTelemetryMalfunction(rawSpeed, rawTemp, rawThrottle, rawLoad, true);
            } else {
              isLiveRemoteRef.current = false;
            }

            const timeStr = new Date(packetTime).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

            // Update primary telemetry UI state to mirror laptop
            setTelemetry({
              rpm: rawRpm,
              speed: rawSpeed,
              temp: rawTemp,
              coolantTemp: rawTemp,
              throttle: rawThrottle,
              load: rawLoad,
              gear: 1,
              timestamp: timeStr,
              timestampMs: packetTime
            });

            // Update statistics
            setStats((prev) => {
              const updateMetric = (current: number | null, val: number, isMin: boolean) => {
                if (current === null) return val;
                return isMin ? Math.min(current, val) : Math.max(current, val);
              };

              return {
                rpm: {
                  min: updateMetric(prev.rpm.min, rawRpm, true),
                  max: updateMetric(prev.rpm.max, rawRpm, false),
                  sum: prev.rpm.sum + rawRpm,
                  count: prev.rpm.count + 1
                },
                speed: {
                  min: updateMetric(prev.speed.min, rawSpeed, true),
                  max: updateMetric(prev.speed.max, rawSpeed, false),
                  sum: prev.speed.sum + rawSpeed,
                  count: prev.speed.count + 1
                },
                temp: {
                  min: updateMetric(prev.temp.min, rawTemp, true),
                  max: updateMetric(prev.temp.max, rawTemp, false),
                  sum: prev.temp.sum + rawTemp,
                  count: prev.temp.count + 1
                },
                throttle: {
                  min: updateMetric(prev.throttle.min, rawThrottle, true),
                  max: updateMetric(prev.throttle.max, rawThrottle, false),
                  sum: prev.throttle.sum + rawThrottle,
                  count: prev.throttle.count + 1
                },
                load: {
                  min: updateMetric(prev.load.min, rawLoad, true),
                  max: updateMetric(prev.load.max, rawLoad, false),
                  sum: prev.load.sum + rawLoad,
                  count: prev.load.count + 1
                },
                gear: prev.gear
              };
            });

            // Update scrolling timeline history
            setHistory((prev) => {
              const nextRpm = [...prev.rpm, rawRpm];
              const nextSpeed = [...prev.speed, rawSpeed];
              const nextTemp = [...prev.temp, rawTemp];
              const nextThrottle = [...prev.throttle, rawThrottle];
              const nextLoad = [...(prev.load || []), rawLoad];
              const nextTimestamps = [...prev.timestamps, timeStr];

              const cap = historyCapacityRef.current;
              if (nextRpm.length > cap) {
                nextRpm.shift();
                nextSpeed.shift();
                nextTemp.shift();
                nextThrottle.shift();
                if (nextLoad.length > cap) nextLoad.shift();
                nextTimestamps.shift();
              }

              return {
                rpm: nextRpm,
                speed: nextSpeed,
                temp: nextTemp,
                throttle: nextThrottle,
                load: nextLoad,
                gear: prev.gear,
                timestamps: nextTimestamps
              };
            });
          } catch (rxErr) {
            console.warn('[Firebase RTDB] Error handling telemetry snapshot:', rxErr);
          }
        },
        (error) => {
          console.warn('[Firebase RTDB] Telemetry mirroring listener error:', error);
        }
      );

      return () => {
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      };
    } catch (err) {
      console.warn('[Firebase RTDB] Telemetry mirroring setup error:', err);
    }
  }, [connectionStatus]);

  // 3. Accelerometer Collision Crash SOS & Mobile Shake-to-SOS (DeviceMotionEvent with firm threshold to prevent false triggers)
  useEffect(() => {
    let shakeCount = 0;
    let firstShakeTime = 0;

    const requestPermissionIfNeeded = () => {
      if (typeof (DeviceMotionEvent as any)?.requestPermission === 'function') {
        (DeviceMotionEvent as any).requestPermission().catch(() => {});
      }
    };
    window.addEventListener('click', requestPermissionIfNeeded, { once: true });
    window.addEventListener('touchstart', requestPermissionIfNeeded, { once: true });

    const handleDeviceMotion = (event: DeviceMotionEvent) => {
      if (crashTriggeredRef.current) return;

      let netForce = 0;
      if (event.acceleration && (event.acceleration.x !== null || event.acceleration.y !== null || event.acceleration.z !== null)) {
        const x = event.acceleration.x || 0;
        const y = event.acceleration.y || 0;
        const z = event.acceleration.z || 0;
        netForce = Math.sqrt(x * x + y * y + z * z);
      } else if (event.accelerationIncludingGravity) {
        const x = event.accelerationIncludingGravity.x || 0;
        const y = event.accelerationIncludingGravity.y || 0;
        const z = event.accelerationIncludingGravity.z || 0;
        const total = Math.sqrt(x * x + y * y + z * z);
        netForce = Math.abs(total - 9.8);
      }

      const now = Date.now();

      // Significantly reduced shake sensitivity (netForce > 100 m/s²) requiring a very deliberate, heavy shake to completely eliminate accidental triggers
      if (netForce > 100) {
        if (shakeCount === 0 || now - firstShakeTime > 3000) {
          firstShakeTime = now;
          shakeCount = 1;
        } else {
          shakeCount++;
        }

        // When a heavy deliberate shake exceeds threshold (100 m/s²), write emergency flag to Firebase
        safeFirebaseSet('vehicle/sos', true);

        // Trigger local crash lockdown within 3 seconds when phone is heavily shaken (threshold >= 100 m/s² or 2 heavy shakes)
        if (netForce >= 100 || shakeCount >= 2) {
          triggerVehicleImpactCrash(
            `PHYSICAL COLLISION DETECTED: ACCELEROMETER ACCELERATION ${netForce.toFixed(1)} m/s²`
          );
        }
      }
    };

    window.addEventListener('devicemotion', handleDeviceMotion, true);
    return () => {
      window.removeEventListener('devicemotion', handleDeviceMotion, true);
      window.removeEventListener('click', requestPermissionIfNeeded);
      window.removeEventListener('touchstart', requestPermissionIfNeeded);
    };
  }, []);

  // 1. MQTT Cloud Bridge Setup
  useEffect(() => {
    let isMounted = true;
    let pollInterval: any = null;
    let fallbackTimeout: any = null;
    let activeClient: any = null;

    const setupMqtt = (brokerIndex = 0) => {
      const mqttLib = (window as any).mqtt || mqtt;
      if (typeof window !== 'undefined' && mqttLib) {
        (window as any).mqtt = mqttLib;
      }
      if (!mqttLib || typeof mqttLib.connect !== 'function') {
        pollInterval = setTimeout(() => setupMqtt(brokerIndex), 250);
        return;
      }

      if (brokerIndex >= MQTT_BROKERS.length) {
        setMqttStatus('disconnected');
        addLog('MQTT Cloud Bridge: All public brokers unreachable. Operating in standalone telemetry mode.', 'system');
        return;
      }

      const brokerUrl = MQTT_BROKERS[brokerIndex];
      setActiveBrokerUrl(brokerUrl);

      try {
        setMqttStatus('connecting');
        addLog(`Connecting to MQTT Cloud Bridge at ${brokerUrl}...`);

        let connectedOnce = false;
        let hasAdvanced = false;

        const client = mqttLib.connect(brokerUrl, {
          clientId: clientIdRef.current,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 0, // Prevent uncontrolled WebSocket reconnect loops before initial connect succeeds
          keepalive: 60
        });
        activeClient = client;

        // Permanent safety error listener to guarantee no unhandled error events bubble to global scope
        client.on('error', (err: any) => {
          console.warn('[MQTT Handled Broker Error]', err?.message || err);
          if (!isMounted) return;
          if (timeoutId) clearTimeout(timeoutId);
          if (!connectedOnce) {
            tryNextBroker(err?.message || 'handshake error');
          } else {
            setMqttStatus('error');
          }
        });

        const tryNextBroker = (reason: string) => {
          if (hasAdvanced || connectedOnce || !isMounted) return;
          hasAdvanced = true;
          if (timeoutId) clearTimeout(timeoutId);

          try {
            // Cancel internal timers in mqtt.js if present
            if ((client as any)?.connackTimer) {
              clearTimeout((client as any).connackTimer);
              (client as any).connackTimer = null;
            }
            if ((client as any)?._connackTimer) {
              clearTimeout((client as any)._connackTimer);
              (client as any)._connackTimer = null;
            }
            if ((client as any)?._connectTimer) {
              clearTimeout((client as any)._connectTimer);
              (client as any)._connectTimer = null;
            }
            // Remove listeners but keep a catch-all error handler so late connack timeouts don't throw uncaught
            client.removeAllListeners();
            client.on('error', () => {});
            client.end(true);
          } catch (_) {}

          if (brokerIndex < MQTT_BROKERS.length - 1) {
            addLog(`Broker ${brokerUrl} unreachable (${reason}). Switching to backup broker...`, 'system');
            fallbackTimeout = setTimeout(() => {
              if (isMounted) setupMqtt(brokerIndex + 1);
            }, 500);
          } else {
            setMqttStatus('disconnected');
            addLog('MQTT Cloud Bridge offline (No public broker reached). Local telemetry active.', 'system');
          }
        };

        const timeoutId = setTimeout(() => {
          if (!connectedOnce) {
            tryNextBroker('connection timeout');
          }
        }, 5500);

        client.on('connect', () => {
          if (!isMounted) return;
          clearTimeout(timeoutId);
          connectedOnce = true;
          setMqttStatus('connected');
          if (client.options) {
            client.options.reconnectPeriod = 10000;
          }
          addLog(`MQTT Cloud Bridge online [${brokerUrl}]. Subscribing to: ${SOS_TOPIC}`);
          client.subscribe(SOS_TOPIC, (err: any) => {
            if (!err) {
              addLog(`Subscribed to MQTT SOS topic: ${SOS_TOPIC}`);
            } else {
              addLog(`MQTT Subscribe Error: ${err.message || err}`);
            }
          });
        });

        client.on('message', (topic: string, message: any) => {
          if (!isMounted) return;
          if (topic === SOS_TOPIC) {
            const rawMsg = message.toString();
            addLog(`Cloud SOS message received on [${topic}]: ${rawMsg}`);
            let parsed: any = null;
            try {
              parsed = JSON.parse(rawMsg);
            } catch (_) {}

            if (parsed?.senderId && parsed.senderId === clientIdRef.current && crashTriggeredRef.current) {
              return;
            }

            const cause = parsed?.cause || `REMOTE CLOUD OVERRIDE: ${rawMsg}`;
            const lat = parsed?.location?.latitude ?? 'CLOUD DISPATCH';
            const lon = parsed?.location?.longitude ?? 'CLOUD DISPATCH';
            lockdownUI(cause, lat, lon);
          }
        });

        client.on('close', () => {
          if (!isMounted) return;
          if (!connectedOnce) {
            if (timeoutId) clearTimeout(timeoutId);
            tryNextBroker('socket closed before connect');
          } else {
            setMqttStatus('disconnected');
          }
        });

        mqttClientRef.current = client;
      } catch (err: any) {
        console.warn('MQTT setup exception:', err);
        if (isMounted) setMqttStatus('disconnected');
      }
    };

    setupMqtt(0);

    return () => {
      isMounted = false;
      if (pollInterval) clearTimeout(pollInterval);
      if (fallbackTimeout) clearTimeout(fallbackTimeout);
      const c = activeClient || mqttClientRef.current;
      if (c) {
        try {
          if (c.connackTimer) {
            clearTimeout(c.connackTimer);
            c.connackTimer = null;
          }
          if (c._connackTimer) {
            clearTimeout(c._connackTimer);
            c._connackTimer = null;
          }
          if (c._connectTimer) {
            clearTimeout(c._connectTimer);
            c._connectTimer = null;
          }
          c.removeAllListeners();
          c.on('error', () => {});
          c.end(true);
        } catch (_) {}
      }
    };
  }, []);

  // SOS Protocol & Sensor Malfunction Manual Test Triggers for Hardware Bench Testing
  const triggerTestGForce = () => {
    addLog('Simulating physical accelerometer shock event (> 100 m/s²)...', 'system');
    const customEvent = new Event('devicemotion') as any;
    customEvent.acceleration = { x: 65, y: 60, z: 50 };
    customEvent.accelerationIncludingGravity = { x: 65, y: 60, z: 50 };
    window.dispatchEvent(customEvent);
  };

  const triggerTestTempAnomaly = () => {
    addLog('Simulating Coolant Temp pin anomaly (Reading 125 °C >= 120 °C)...', 'system');
    if (simStateRef.current) simStateRef.current.temp = 125;
    handleParsedLine(`2400,65,125.0,45,55`);
  };

  const triggerTestSpeedAnomaly = () => {
    addLog('Simulating Vehicle Speed sensor anomaly (Speed = 0 KM/H with Engine Load > 20%)...', 'system');
    if (simStateRef.current) {
      simStateRef.current.speed = 0;
      simStateRef.current.load = 45;
    }
    handleParsedLine(`2200,0.0,88.0,40,45`);
  };

  const triggerTestThrottleAnomaly = () => {
    addLog('Simulating Throttle Position sensor anomaly (Reading 108% > 100%)...', 'system');
    if (simStateRef.current) simStateRef.current.throttle = 108;
    handleParsedLine(`3000,55,90.0,108,70`);
  };

  const triggerTestLoadAnomaly = () => {
    addLog('Simulating Engine Load sensor anomaly (Reading 99% >= 98%)...', 'system');
    if (simStateRef.current) simStateRef.current.load = 99;
    handleParsedLine(`3400,75,94.0,90,99`);
  };

  const triggerClearFault = () => {
    addLog('Simulating jumper wire removal (Sensor data returned to normal baseline limits)...', 'system');
    safeFirebaseSet('vehicle/sos', false);
    if (simStateRef.current) {
      simStateRef.current.temp = 88;
      simStateRef.current.speed = 64;
      simStateRef.current.throttle = 42;
      simStateRef.current.load = 38;
      simStateRef.current.rpm = 3040;
    }
    handleParsedLine(`3040,64.0,88.0,42,38`);
  };

  const triggerFastForward60s = () => {
    addLog('Fast-forwarding active sensor anomaly stopwatch to 10s escalation threshold...', 'system');
    if (!activeMalfunctionRef.current) {
      triggerTestTempAnomaly();
    }
    if (activeMalfunctionRef.current) {
      activeMalfunctionRef.current.startTime = Date.now() - 11000;
      triggerMalfunctionEscalation(
        activeMalfunctionRef.current.sensorLabel,
        activeMalfunctionRef.current.details,
        '00:10'
      );
    }
  };

  const triggerTestCloudMqtt = () => {
    addLog(`Publishing test SOS payload to MQTT topic: ${SOS_TOPIC}...`, 'system');
    if (mqttClientRef.current && mqttClientRef.current.connected) {
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        location: { latitude: 37.774929, longitude: -122.419416 },
        cause: "REMOTE CLOUD OVERRIDE: FLEET DISPATCH TRIGGER",
        senderId: 'remote_fleet_test'
      });
      mqttClientRef.current.publish(SOS_TOPIC, payload, { qos: 1 });
    } else {
      lockdownUI("REMOTE CLOUD OVERRIDE: SOS DISPATCH TRIGGER", 37.774929, -122.419416);
    }
  };

  // Expose to window for external/developer access & testing
  useEffect(() => {
    (window as any).executeCrashProtocol = (cause: string) => triggerVehicleImpactCrash(cause);
    (window as any).triggerVehicleImpactCrash = triggerVehicleImpactCrash;
    (window as any).triggerMalfunctionEscalation = triggerMalfunctionEscalation;
    (window as any).evaluateTelemetryMalfunction = evaluateTelemetryMalfunction;
    (window as any).triggerTestTempAnomaly = triggerTestTempAnomaly;
    (window as any).triggerTestSpeedAnomaly = triggerTestSpeedAnomaly;
    (window as any).triggerTestThrottleAnomaly = triggerTestThrottleAnomaly;
    (window as any).triggerTestLoadAnomaly = triggerTestLoadAnomaly;
    (window as any).triggerClearFault = triggerClearFault;
    (window as any).triggerFastForward60s = triggerFastForward60s;
    (window as any).lockdownUI = lockdownUI;
  }, []);

  // Web Serial API Refs
  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const keepReadingRef = useRef<boolean>(false);
  const packetCountRef = useRef<number>(0);
  const serialBufferRef = useRef<string>('');
  const dataLogRef = useRef<Array<{
    timestamp: string;
    rpm: number;
    speed: number;
    temp: number;
    throttle: number;
    gear: number;
  }>>([]);

  // Refs for tracking mutable state inside non-reactive loops / intervals
  const historyCapacityRef = useRef<number>(100);
  const consoleActiveRef = useRef<boolean>(true);
  const simProfileRef = useRef<any>('cruise');
  const lastFirebaseTelemetrySyncRef = useRef<number>(0);
  const simStateRef = useRef({
    rpm: 3040,
    speed: 64.0,
    temp: 88.0,
    throttle: 42,
    load: 38,
    gear: 1,
    time: 0,
    shifting: false,
    shiftTimer: 0
  });

  // Synchronize refs with state to prevent stale closure bugs in intervals
  useEffect(() => {
    historyCapacityRef.current = historyCapacity;
  }, [historyCapacity]);

  useEffect(() => {
    consoleActiveRef.current = isConsoleActive;
  }, [isConsoleActive]);

  useEffect(() => {
    simProfileRef.current = simProfile;
  }, [simProfile]);

  // Dynamic system logger helper
  const addLog = (message: string, type: 'system' | 'data' = 'system') => {
    const timeStr = new Date().toLocaleTimeString([], { hour12: false });
    const formatted = `[${timeStr}] [${type.toUpperCase()}] ${message}`;
    setConsoleLogs(prev => {
      const nextLogs = [...prev, formatted];
      if (nextLogs.length > 200) nextLogs.shift();
      return nextLogs;
    });
  };

  // Calculate telemetry frequency (Hz / Packets per second)
  useEffect(() => {
    const hzInterval = setInterval(() => {
      setDataHz(packetCountRef.current);
      packetCountRef.current = 0;
    }, 1000);

    return () => clearInterval(hzInterval);
  }, []);

  // Simulator loop implementation
  const simIntervalRef = useRef<any>(null);
  useEffect(() => {
    if (connectionStatus === 'simulator') {
      const initialTruck = truckRef.current;
      // Reset simulator physics state to baseline undisturbed state
      simStateRef.current = {
        rpm: 3040,
        speed: 64.0,
        temp: 88.0,
        throttle: 42,
        load: 38,
        gear: 1,
        time: 0,
        shifting: false,
        shiftTimer: 0
      };

      addLog(`Initializing Telematics Simulator for ${initialTruck.name} (${initialTruck.model})`);

      simIntervalRef.current = setInterval(() => {
        const truck = truckRef.current; // Read active truck profile dynamically
        const state = simStateRef.current;
        const profile = simProfileRef.current;
        const dt = 1 / simHz;
        state.time += dt;

        if (profile === 'cruise') {
          // Highway Cruise: smooth, steady undisturbed state 64 KM/H (RPM ~3040, Temp ~88°C, Throttle ~42%, Load ~38%)
          state.throttle = 42 + Math.sin(state.time * 0.4) * 1.5;
          const targetRpm = 3040 + Math.sin(state.time * 0.3) * 20;
          state.rpm = state.rpm * 0.92 + targetRpm * 0.08;
          const targetSpeed = 64.0 + Math.sin(state.time * 0.2) * 0.6;
          state.speed = state.speed * 0.94 + targetSpeed * 0.06;
          state.temp = 88.0 + Math.sin(state.time * 0.05) * 0.5;
          state.load = 38.0 + Math.sin(state.time * 0.4) * 1.5;
        } else if (profile === 'drag') {
          // Drag Strip: 0-100% full throttle launches, upshifts at redline
          const dragTime = state.time % 20;
          if (dragTime < 13) {
            state.throttle = 100;
            if (state.shifting) {
              state.shiftTimer--;
              if (state.shiftTimer <= 0) {
                state.shifting = false;
                state.rpm = Math.max(750, state.rpm - truck.shiftDropRpm * 0.8);
              } else {
                state.throttle = 30;
                state.rpm = Math.max(700, state.rpm - 150);
              }
            } else {
              state.rpm += 90 * truck.accelFactor;
              if (state.rpm >= truck.redlineRpm * 0.96 && state.gear < truck.maxGears) {
                state.shifting = true;
                state.shiftTimer = 1;
                state.gear++;
              }
              const gearRatio = truck.gearRatios[state.gear] || 0.03;
              const targetKmh = (state.rpm / truck.redlineRpm) * (truck.maxSpeedKmh * (state.gear / truck.maxGears) * 1.15);
              state.speed = state.speed * 0.88 + (Math.min(truck.maxSpeedKmh, targetKmh) / 1.60934) * 0.12;
            }
            state.temp = Math.min(108, state.temp + 0.08);
          } else {
            state.throttle = 0;
            state.speed = Math.max(0, state.speed - 8);
            state.rpm = Math.max(750, state.rpm - 220);
            if (state.speed < 5) state.gear = 1;
            state.temp = Math.max(84, state.temp - 0.1);
          }
          state.load = Math.min(100, Math.max(10, (state.throttle * 0.8) + (state.rpm / truck.redlineRpm * 25)));
        } else if (profile === 'overheat') {
          // Coolant Failure: severe thermal ramp
          state.throttle = Math.min(95, 60 + Math.sin(state.time * 0.5) * 30);
          state.rpm = Math.min(truck.redlineRpm * 0.9, 2200 + Math.sin(state.time * 0.4) * 1000);
          state.speed = 50 + Math.sin(state.time * 0.3) * 15;
          state.gear = Math.min(truck.maxGears, Math.max(2, Math.floor(truck.maxGears * 0.6)));
          state.load = Math.min(100, 75 + Math.sin(state.time * 0.4) * 15);
          // Ramps temp past 118°C!
          state.temp = Math.min(125, 82 + (state.time * 0.55));
        } else {
          // 'track' (Default dynamic road course loop)
          const cycleTime = state.time % 36; // 36 second simulation loop

          if (cycleTime < 22) {
            // Acceleration / power delivery cycle
            // Throttle ramps up at realistic rate per profile
            const throttleStep = truck.id === 'class8' ? 4 : truck.id === 'medium' ? 7 : 12;
            state.throttle = Math.min(100, state.throttle + throttleStep);

            if (state.shifting) {
              state.shiftTimer--;
              if (state.shiftTimer <= 0) {
                state.shifting = false;
                // RPM drops upon shift completion according to shiftDropRpm
                state.rpm = Math.max(750, state.rpm - truck.shiftDropRpm + (Math.random() * 40 - 20));
              } else {
                // During gear shifting, accelerator dips
                state.throttle = 15;
                state.rpm = Math.max(700, state.rpm - (truck.shiftDropRpm * 0.3));
              }
            } else {
              // Power increment scaled by vehicle's accelFactor and gear load
              const powerInc = (state.throttle * 0.7 * truck.accelFactor) + (truck.maxGears + 1 - state.gear) * (18 * truck.accelFactor);
              state.rpm += powerInc + (Math.random() * 20 - 10);

              // Speed calculation using gear ratio
              const gearRatio = truck.gearRatios[state.gear] || truck.gearRatios[truck.maxGears] || 0.03;
              const targetKmh = (state.rpm / truck.redlineRpm) * (truck.maxSpeedKmh * (state.gear / truck.maxGears) * 1.1);
              const cappedKmh = Math.min(truck.maxSpeedKmh, targetKmh);
              const targetMph = cappedKmh / 1.60934;

              state.speed = state.speed * 0.90 + targetMph * 0.10;

              // Upshift threshold: triggers shift when RPM approaches redline (e.g. 94% of redline)
              if (state.rpm >= truck.redlineRpm * 0.94 && state.gear < truck.maxGears) {
                state.shifting = true;
                state.shiftTimer = truck.id === 'class8' ? 3 : truck.id === 'medium' ? 2 : 1; // Class 8 slow shift delay
                state.gear++;
              } else if (state.rpm > truck.redlineRpm) {
                // Engine rev governor bounce
                state.rpm = truck.redlineRpm - 40 + (Math.random() * 30 - 15);
              }
            }
            // Temperature engine load
            state.temp = Math.min(104, state.temp + 0.04);
          } else if (cycleTime < 30) {
            // Deceleration / Braking phase
            state.throttle = 0;
            const brakeStep = truck.id === 'class8' ? 3.5 : 7.0;
            state.speed = Math.max(0, state.speed - brakeStep);

            // Auto-downshift logic
            if (state.gear > 1) {
              const currentRatio = truck.gearRatios[state.gear] || 0.02;
              const approxSpeedKmh = state.speed * 1.60934;
              if (approxSpeedKmh < (truck.maxSpeedKmh * ((state.gear - 1) / truck.maxGears) * 0.7)) {
                state.gear--;
                state.rpm = Math.min(truck.redlineRpm * 0.85, state.rpm + 350); // Rev blip
              } else {
                state.rpm = Math.max(750, (approxSpeedKmh / (currentRatio * 1000)) || 800);
              }
            } else {
              state.rpm = Math.max(750, state.rpm - 100);
            }
            state.temp = Math.max(82, state.temp - 0.08);
          } else {
            // Cruising phase
            state.throttle = Math.min(50, state.throttle + 8);
            state.speed += 1.2;
            state.rpm = Math.max(800, Math.min(truck.redlineRpm * 0.8, state.rpm + 60));
            state.temp = Math.min(92, state.temp + 0.02);
          }

          // Compute dynamic Engine Load % (increases under throttle, steep climb, or heavy gear acceleration)
          const targetLoad = Math.min(100, Math.max(8, (state.throttle * 0.7) + ((state.rpm / truck.redlineRpm) * 35) + (state.shifting ? 15 : 0)));
          state.load = state.load * 0.85 + targetLoad * 0.15;
        }

        // Format CSV line strictly as 5 variables: RPM, Speed, Temp, Throttle, Load
        const line = `${Math.round(state.rpm)},${state.speed.toFixed(1)},${state.temp.toFixed(1)},${Math.round(state.throttle)},${Math.round(state.load)}`;
        handleParsedLine(line);
      }, Math.round(1000 / simHz));
    }

    return () => {
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
    };
  }, [connectionStatus, simHz]);

  // Main stream parsing algorithm
  const handleParsedLine = (line: string) => {
    try {
      // Increment packet metric
      packetCountRef.current++;

      if (consoleActiveRef.current) {
        addLog(line, 'data');
      }

      // 1. Ensure the CSV stream splits into exactly 5 variables:
      // values[0] = Engine Speed
      // values[1] = Vehicle Speed
      // values[2] = Coolant Temp
      // values[3] = Throttle Pos
      // values[4] = Engine Load
      const values = line.split(',').map((v) => v.trim());

      // 4. Print incoming telemetry directly to F12 Console
      console.log("Telemetry RX:", values);

      if (values.length < 5) {
        return;
      }

      const rpm = parseFloat(values[0]);
      const speed = parseFloat(values[1]);
      const coolantTemp = parseFloat(values[2]);
      const rawThrottle = parseFloat(values[3]);
      const rawLoad = parseFloat(values[4]);

      // Guard against non-numeric payloads
      if (isNaN(rpm) || isNaN(speed) || isNaN(coolantTemp) || isNaN(rawThrottle) || isNaN(rawLoad)) {
        return;
      }

      // 1. Immediately inside parsing loop, broadcast live telemetry to Firebase Realtime Database
      safeFirebaseSet('vehicle/telemetry', {
        speed: speed,
        rpm: rpm,
        coolantTemp: coolantTemp,
        timestamp: Date.now()
      });

      const parsedLoad = Math.min(100, Math.max(0, rawLoad));

      // Evaluate Web Serial telemetry for out-of-bounds sensor anomalies
      // (Vehicle Speed 0 with Load > 20%, Coolant Temp >= 120°C, Throttle < 0% or > 100%, Engine Load >= 98%)
      evaluateTelemetryMalfunction(speed, coolantTemp, rawThrottle, parsedLoad);

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Record raw telemetry data to uncapped dataLogRef
      dataLogRef.current.push({
        timestamp: timeStr,
        rpm: rpm,
        speed: speed,
        temp: coolantTemp,
        throttle: rawThrottle,
        load: parsedLoad,
        gear: 1
      });

      // Update real-time state
      setTelemetry({
        rpm: rpm,
        speed: speed,
        temp: coolantTemp,
        coolantTemp: coolantTemp,
        throttle: rawThrottle,
        load: parsedLoad,
        gear: 1,
        timestamp: timeStr,
        timestampMs: Date.now()
      });

      const rawRpm = rpm;
      const rawSpeed = speed;
      const rawTemp = coolantTemp;

      // Add to statistics
      setStats((prev) => {
        const updateMetric = (current: number | null, val: number, isMin: boolean) => {
          if (current === null) return val;
          return isMin ? Math.min(current, val) : Math.max(current, val);
        };

        return {
          rpm: {
            min: updateMetric(prev.rpm.min, rawRpm, true),
            max: updateMetric(prev.rpm.max, rawRpm, false),
            sum: prev.rpm.sum + rawRpm,
            count: prev.rpm.count + 1
          },
          speed: {
            min: updateMetric(prev.speed.min, rawSpeed, true),
            max: updateMetric(prev.speed.max, rawSpeed, false),
            sum: prev.speed.sum + rawSpeed,
            count: prev.speed.count + 1
          },
          temp: {
            min: updateMetric(prev.temp.min, rawTemp, true),
            max: updateMetric(prev.temp.max, rawTemp, false),
            sum: prev.temp.sum + rawTemp,
            count: prev.temp.count + 1
          },
          throttle: {
            min: updateMetric(prev.throttle.min, rawThrottle, true),
            max: updateMetric(prev.throttle.max, rawThrottle, false),
            sum: prev.throttle.sum + rawThrottle,
            count: prev.throttle.count + 1
          },
          load: {
            min: updateMetric(prev.load.min, parsedLoad, true),
            max: updateMetric(prev.load.max, parsedLoad, false),
            sum: prev.load.sum + parsedLoad,
            count: prev.load.count + 1
          },
          gear: prev.gear
        };
      });

      // Update scrolling buffers
      setHistory((prev) => {
        const nextRpm = [...prev.rpm, rawRpm];
        const nextSpeed = [...prev.speed, rawSpeed];
        const nextTemp = [...prev.temp, rawTemp];
        const nextThrottle = [...prev.throttle, rawThrottle];
        const nextLoad = [...(prev.load || []), parsedLoad];
        const nextTimestamps = [...prev.timestamps, timeStr];

        const cap = historyCapacityRef.current;
        if (nextRpm.length > cap) {
          nextRpm.shift();
          nextSpeed.shift();
          nextTemp.shift();
          nextThrottle.shift();
          if (nextLoad.length > cap) nextLoad.shift();
          nextTimestamps.shift();
        }

        return {
          rpm: nextRpm,
          speed: nextSpeed,
          temp: nextTemp,
          throttle: nextThrottle,
          load: nextLoad,
          gear: prev.gear,
          timestamps: nextTimestamps
        };
      });
    } catch (err: any) {
      // 3. Wrap packet handler in try...catch so a single bad packet won't stop the loop
      console.error("Telemetry packet parse error:", err);
    }
  };

  // Web Serial Loop
  const readSerialStream = async (port: any) => {
    let reader;
    try {
      const decoder = new TextDecoderStream();
      const readableStreamClosed = port.readable.pipeTo(decoder.writable);
      reader = decoder.readable.getReader();
      readerRef.current = reader;

      addLog('Continuous data stream reading process started.');

      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) {
          addLog('Serial reader stream closed from external event.');
          break;
        }
        if (value) {
          serialBufferRef.current += value;
          const lines = serialBufferRef.current.split('\n');
          serialBufferRef.current = lines.pop() || ''; // Keep partial last line

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              try {
                handleParsedLine(trimmed);
              } catch (packetErr: any) {
                console.warn('Packet processing error caught, continuing loop:', packetErr);
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error(err);
      addLog(`Serial Stream Read Error: ${err.message || err}`);
    } finally {
      if (reader) {
        try {
          reader.releaseLock();
        } catch (e) {}
      }
      handleDisconnect();
    }
  };

  // Web Serial API Actions
  const handleConnect = async () => {
    try {
      setConnectionStatus('connecting');
      addLog('Requesting USB Web Serial authorization dialog...');

      if (!('serial' in navigator)) {
        throw new Error('Your browser does not support the native Web Serial API. Please use Google Chrome, Microsoft Edge, or Opera. If you are viewing this applet in a preview iframe, try clicking "Open in New Tab" in the top right.');
      }

      const port = await (navigator as any).serial.requestPort();
      addLog(`Port authorized. Initializing connection at ${baudRate} Baud...`);
      
      await port.open({ baudRate });
      addLog('USB Web Serial connection established successfully.');
      
      portRef.current = port;
      keepReadingRef.current = true;
      setConnectionStatus('connected');
      
      // Start non-blocking stream listener
      readSerialStream(port);
    } catch (err: any) {
      console.error(err);
      const errMsg = err.message || String(err);
      const isPermission = errMsg.toLowerCase().includes('permission') || 
                           errMsg.toLowerCase().includes('policy') || 
                           errMsg.toLowerCase().includes('disallowed') || 
                           errMsg.toLowerCase().includes('security');
      
      addLog(`Connection failed: ${errMsg}`);
      setConnectionStatus('disconnected');

      if (isPermission) {
        setErrorAlert({
          message: 'The Web Serial connection was blocked by the browser\'s permissions policy. This typically occurs when the application is running inside an iframe (like this preview). To establish a real physical USB Serial connection, please open this application in a new tab by clicking the "Open in New Tab" button in the upper right.',
          isPermission: true
        });
      } else {
        setErrorAlert({
          message: `Failed to open Web Serial connection: ${errMsg}`,
          isPermission: false
        });
      }
    }
  };

  const handleDisconnect = async () => {
    keepReadingRef.current = false;
    addLog('Initiating port shutdown routine...');

    if (readerRef.current) {
      try {
        await readerRef.current.cancel();
      } catch (e) {}
      readerRef.current = null;
    }

    if (portRef.current) {
      try {
        await portRef.current.close();
      } catch (e) {}
      portRef.current = null;
    }

    setConnectionStatus('disconnected');
    // Ensure all telemetry state variables default to 0 on disconnect
    setTelemetry({
      rpm: 0,
      speed: 0,
      temp: 0,
      coolantTemp: 0,
      throttle: 0,
      load: 0,
      gear: 0,
      timestamp: '--:--:--',
      timestampMs: 0
    });
    addLog('Serial connection severed. Controller disconnected.');
  };

  // Trigger local simulation
  const handleToggleSimulator = () => {
    if (connectionStatus === 'simulator') {
      setConnectionStatus('disconnected');
      // Ensure all telemetry state variables default to 0 when simulator is stopped
      setTelemetry({
        rpm: 0,
        speed: 0,
        temp: 0,
        coolantTemp: 0,
        throttle: 0,
        load: 0,
        gear: 0,
        timestamp: '--:--:--',
        timestampMs: 0
      });
      addLog('Simulator telemetry stopped.');
    } else {
      // Disconnect active hardware first
      if (connectionStatus === 'connected') {
        handleDisconnect();
      }
      setConnectionStatus('simulator');
    }
  };

  const handleResetSession = () => {
    setStats({
      rpm: { min: null, max: null, sum: 0, count: 0 },
      speed: { min: null, max: null, sum: 0, count: 0 },
      temp: { min: null, max: null, sum: 0, count: 0 },
      throttle: { min: null, max: null, sum: 0, count: 0 },
      load: { min: null, max: null, sum: 0, count: 0 },
      gear: { min: null, max: null, sum: 0, count: 0 },
    });
    setHistory({
      rpm: [],
      speed: [],
      temp: [],
      throttle: [],
      load: [],
      gear: [],
      timestamps: []
    });
    dataLogRef.current = [];
    addLog('Session historic charts, min/max statistics, and data logs purged.');
  };

  // Exporter for CSV analysis - downloads complete log
  const downloadCSV = () => {
    if (dataLogRef.current.length === 0) {
      alert('No telemetry data collected in current session to export.');
      return;
    }

    addLog(`Compiling ${dataLogRef.current.length} telemetry records for CSV export...`);
    
    const headers = ['Timestamp', 'Engine Speed (RPM)', 'Vehicle Speed', 'Coolant Temp', 'Throttle Pos', 'Engine Load'];
    const csvRows = [headers.join(',')];

    for (const record of dataLogRef.current) {
      csvRows.push([
        record.timestamp,
        record.rpm,
        record.speed,
        record.temp,
        record.throttle,
        record.load ?? 0
      ].join(','));
    }

    const csvContent = 'data:text/csv;charset=utf-8,' + csvRows.join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `ecg_telemetry_log_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addLog('CSV Telemetry log downloaded successfully.');
  };

  // Unit conversions
  const displaySpeed = (raw: number) => {
    if (speedUnit === 'KMH') {
      return Math.round(raw * 1.60934);
    }
    return Math.round(raw);
  };

  const displayTemp = (raw: number) => {
    if (tempUnit === 'F') {
      return Math.round((raw * 9) / 5 + 32);
    }
    return Math.round(raw * 10) / 10;
  };

  const isOverheating = telemetry.temp >= thresholds.tempWarning;

  const dispSpeed = speedUnit === 'KMH' ? Math.round(telemetry.speed) : Math.round(telemetry.speed * 0.621371);
  const rawTempVal = telemetry.coolantTemp !== undefined ? telemetry.coolantTemp : telemetry.temp;
  const dispTemp = (!isConnected && !isSimulator && !isLiveRemoteRef.current)
    ? 0
    : (tempUnit === 'F' ? Math.round((rawTempVal * 9) / 5 + 32) : Math.round(rawTempVal));
  
  const isRpmAlert = telemetry.rpm >= thresholds.rpmWarning;
  const isSpeedAlert = speedUnit === 'KMH' ? dispSpeed >= 120 : dispSpeed >= 75;
  const isTempAlert = tempUnit === 'F' ? dispTemp >= 203 : telemetry.temp >= thresholds.tempWarning;
  const isThrottleAlert = telemetry.throttle >= 85;
  const isLoadAlert = telemetry.load >= 85;

  // Helper to fetch live parameter configuration & rolling data for each of the 5 telemetry channels
  const getMetricConfig = (mKey: 'rpm' | 'speed' | 'temp' | 'throttle' | 'load') => {
    const isStreamActive = isConnected || isSimulator;
    switch (mKey) {
      case 'rpm':
        return {
          key: 'rpm' as const,
          label: 'ENGINE SPEED',
          data: history.rpm,
          unit: 'RPM',
          minY: 0,
          maxY: activeTruck.chartMaxRpm,
          alert: Boolean(isStreamActive && isRpmAlert),
          alertThreshold: activeTruck.rpmWarning,
          currentValue: `${isStreamActive ? Math.round(telemetry.rpm) : 0} RPM`,
          color: isRpmAlert ? '#FF0000' : (theme === 'light' ? '#006622' : '#00FF66')
        };
      case 'speed':
        return {
          key: 'speed' as const,
          label: 'VEHICLE SPEED',
          data: history.speed.map(s => speedUnit === 'KMH' ? Math.round(s * 1.60934) : Math.round(s)),
          unit: speedUnit,
          minY: 0,
          maxY: speedUnit === 'KMH' ? activeTruck.maxSpeedKmh : activeTruck.maxSpeedMph,
          alert: Boolean(isStreamActive && isSpeedAlert),
          alertThreshold: speedUnit === 'KMH' ? activeTruck.maxSpeedKmh : activeTruck.maxSpeedMph,
          currentValue: `${isStreamActive ? dispSpeed : 0} ${speedUnit}`,
          color: isSpeedAlert ? '#FF0000' : (theme === 'light' ? '#006622' : '#00FF66')
        };
      case 'temp':
        return {
          key: 'temp' as const,
          label: 'COOLANT TEMP',
          data: history.temp.map(t => tempUnit === 'F' ? Math.round((t * 9) / 5 + 32) : Math.round(t)),
          unit: `°${tempUnit}`,
          minY: tempUnit === 'F' ? 32 : 0,
          maxY: tempUnit === 'F' ? 266 : 130,
          alert: Boolean(isStreamActive && isTempAlert),
          alertThreshold: tempUnit === 'F' ? 203 : thresholds.tempWarning,
          currentValue: `${isStreamActive ? dispTemp : 0} °${tempUnit}`,
          color: isTempAlert ? '#FF0000' : (theme === 'light' ? '#006622' : '#00FF66')
        };
      case 'throttle':
        return {
          key: 'throttle' as const,
          label: 'THROTTLE POS',
          data: history.throttle,
          unit: '%',
          minY: 0,
          maxY: 100,
          alert: Boolean(isStreamActive && isThrottleAlert),
          alertThreshold: 85,
          currentValue: `${isStreamActive ? Math.round(telemetry.throttle) : 0}%`,
          color: isThrottleAlert ? '#FF0000' : (theme === 'light' ? '#006622' : '#00FF66')
        };
      case 'load':
        return {
          key: 'load' as const,
          label: 'ENGINE LOAD',
          data: history.load,
          unit: '%',
          minY: 0,
          maxY: 100,
          alert: Boolean(isStreamActive && isLoadAlert),
          alertThreshold: 85,
          currentValue: `${isStreamActive ? Math.round(telemetry.load) : 0}%`,
          color: isLoadAlert ? '#FF0000' : (theme === 'light' ? '#006622' : '#00FF66')
        };
    }
  };

  // 4. Continuous High-DPI Canvas Rendering Engine for Dedicated Lower Stage Graph
  const drawTelemetryToCanvas = (
    canvas: HTMLCanvasElement,
    data: number[],
    config: {
      label: string;
      unit: string;
      minY: number;
      maxY: number;
      alert: boolean;
      alertThreshold?: number;
      color: string;
      currentValue: string;
      capacity: number;
      isLightMode: boolean;
    }
  ) => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Canvas Background
    ctx.fillStyle = config.isLightMode ? '#f8faf9' : '#070b09';
    ctx.fillRect(0, 0, width, height);

    const padLeft = 14;
    const padRight = 14;
    const padTop = 24;
    const padBottom = 22;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    const gridColor = config.isLightMode ? 'rgba(55, 65, 81, 0.12)' : 'rgba(226, 236, 230, 0.08)';
    const textColor = config.isLightMode ? '#4b5563' : '#a1aca5';

    // Horizontal dashed grid divisions (4 lines for roomy stage)
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    [0.2, 0.4, 0.6, 0.8].forEach((pct) => {
      const y = padTop + chartH * pct;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
    });

    // Vertical time sample grid divisions
    [0.2, 0.4, 0.6, 0.8].forEach((pct) => {
      const x = padLeft + chartW * pct;
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, height - padBottom);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Scale min/max and unit text annotations
    ctx.fillStyle = textColor;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${config.maxY} ${config.unit}`, padLeft, 6);

    ctx.textBaseline = 'bottom';
    ctx.fillText(`${config.minY} ${config.unit}`, padLeft, height - 4);

    // Current value live readout in top right
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillStyle = config.alert ? '#FF0000' : config.color;
    ctx.fillText(config.currentValue, width - padRight, 6);

    // Warning Threshold dashed line if active
    if (config.alertThreshold !== undefined && config.alertThreshold > config.minY && config.alertThreshold < config.maxY) {
      const threshRatio = (config.alertThreshold - config.minY) / (config.maxY - config.minY);
      const threshY = height - padBottom - threshRatio * chartH;
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padLeft, threshY);
      ctx.lineTo(width - padRight, threshY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.textAlign = 'right';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255, 0, 0, 0.9)';
      ctx.fillText(`WARN THRESHOLD: ${config.alertThreshold} ${config.unit}`, width - padRight, threshY - 10);
    }

    // Rolling Waveform Drawing
    if (!data || data.length === 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillText('STREAMING REAL-TIME TELEMETRY...', width / 2, height / 2);
      ctx.restore();
      return;
    }

    const range = config.maxY - config.minY || 1;
    const maxCap = Math.max(config.capacity, data.length, 1);
    const points: { x: number; y: number }[] = [];

    for (let i = 0; i < data.length; i++) {
      const x = padLeft + (i / (maxCap - 1)) * chartW;
      const clamped = Math.max(config.minY, Math.min(config.maxY, data[i]));
      const ratio = (clamped - config.minY) / range;
      const y = height - padBottom - ratio * chartH;
      points.push({ x, y });
    }

    if (points.length > 0) {
      // Area Fill Gradient
      const grad = ctx.createLinearGradient(0, padTop, 0, height - padBottom);
      if (config.alert) {
        grad.addColorStop(0, 'rgba(255, 0, 0, 0.35)');
        grad.addColorStop(1, 'rgba(255, 0, 0, 0.0)');
      } else {
        grad.addColorStop(0, config.isLightMode ? 'rgba(0, 102, 34, 0.25)' : 'rgba(0, 255, 102, 0.28)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
      }

      ctx.beginPath();
      ctx.moveTo(points[0].x, height - padBottom);
      for (const pt of points) {
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.lineTo(points[points.length - 1].x, height - padBottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Continuous Neon Telemetry Path Stroke
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.strokeStyle = config.alert ? '#FF0000' : config.color;
      ctx.lineWidth = 2.4;
      ctx.shadowColor = config.alert ? 'rgba(255, 0, 0, 0.75)' : (config.isLightMode ? 'rgba(0, 102, 34, 0.45)' : 'rgba(0, 255, 102, 0.75)');
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Leading Head Marker Dot on latest recorded sample
      const lastPt = points[points.length - 1];
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(lastPt.x, lastPt.y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = config.alert ? '#FF0000' : config.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lastPt.x, lastPt.y, 6.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  };

  // Continuous Canvas Drawing Loop: Smoothly renders the lower #dashboard-graph-stage canvas in real time
  useEffect(() => {
    if (activeTab !== 'dashboard') return;

    let animId: number;
    const renderStageCanvas = () => {
      const canvas = document.getElementById('canvas-dashboard-stage') as HTMLCanvasElement | null;
      if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        const cfg = getMetricConfig(selectedDashboardMetric);
        drawTelemetryToCanvas(canvas, cfg.data, {
          label: cfg.label,
          unit: cfg.unit,
          minY: cfg.minY,
          maxY: cfg.maxY,
          alert: cfg.alert,
          alertThreshold: cfg.alertThreshold,
          color: cfg.color,
          currentValue: cfg.currentValue,
          capacity: historyCapacity,
          isLightMode: theme === 'light'
        });
      }
    };

    animId = requestAnimationFrame(renderStageCanvas);

    const handleResize = () => {
      requestAnimationFrame(renderStageCanvas);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
    };
  }, [
    activeTab,
    selectedDashboardMetric,
    history,
    telemetry,
    activeTruck,
    speedUnit,
    tempUnit,
    theme,
    historyCapacity,
    isRpmAlert,
    isSpeedAlert,
    isTempAlert,
    isThrottleAlert,
    isLoadAlert,
    dispSpeed,
    dispTemp,
    thresholds
  ]);


  // Filter terminal output
  const filteredLogs = useMemo(() => {
    return consoleLogs.filter(log => {
      if (logFilter === 'all') return true;
      if (logFilter === 'data') return log.includes('[DATA]');
      if (logFilter === 'system') return log.includes('[SYSTEM]');
      return true;
    });
  }, [consoleLogs, logFilter]);

  return (
    <div className="dashboard-app-layout selection:bg-[#e2ece6] selection:text-[#0d110f]">
      {/* 2. The Left Ribbon (Navigation Sidebar: Icon-Only Minimalist 72px) */}
      <aside className="left-ribbon">
        {/* Top: ECG Logo & Branding (Compact Centered Icon/Badge) */}
        <div className="ribbon-brand pb-3 border-b border-[#e2ece6]/20 flex flex-col items-center justify-center text-center w-full">
          <div className="text-xl font-black font-mono tracking-[0.15em] text-[#00FF66] leading-none">
            ECG
          </div>
          <div className="text-[7.5px] uppercase tracking-wider font-mono opacity-60 mt-1 font-bold">
            PWA
          </div>
        </div>

        {/* Vertical List of Navigation Buttons (Icon-Only, Centered) */}
        <nav className="nav-list flex flex-col items-center gap-2 my-auto py-2 w-full">
          <button
            id="nav-btn-dashboard"
            onClick={() => switchTab('dashboard')}
            className={`nav-btn ${activeTab === 'dashboard' ? 'active-nav' : ''}`}
            title="LIVE DASHBOARD"
            aria-label="Live Dashboard"
          >
            <Gauge className="w-5 h-5 shrink-0" />
            <span>LIVE DASHBOARD</span>
          </button>

          <button
            id="nav-btn-graphs"
            onClick={() => switchTab('graphs')}
            className={`nav-btn ${activeTab === 'graphs' ? 'active-nav' : ''}`}
            title="TELEMETRY GRAPHS"
            aria-label="Telemetry Graphs"
          >
            <SlidersHorizontal className="w-5 h-5 shrink-0" />
            <span>TELEMETRY GRAPHS</span>
          </button>

          <button
            id="nav-btn-telematics"
            onClick={() => switchTab('telematics')}
            className={`nav-btn ${activeTab === 'telematics' ? 'active-nav' : ''}`}
            title="FLEET TELEMATICS DECK"
            aria-label="Fleet Telematics Deck"
          >
            <Truck className="w-5 h-5 shrink-0" />
            <span>FLEET TELEMATICS DECK</span>
          </button>

          <button
            id="nav-btn-controls"
            onClick={() => switchTab('controls')}
            className={`nav-btn ${activeTab === 'controls' ? 'active-nav' : ''}`}
            title="SETTINGS & CONTROLS"
            aria-label="Settings and Controls"
          >
            <Settings className="w-5 h-5 shrink-0" />
            <span>SETTINGS & CONTROLS</span>
          </button>
        </nav>

        {/* Bottom: Theme Toggle (Desktop sidebar bottom, mobile horizontal item) */}
        <div className="theme-toggle-wrapper pt-0 md:pt-3 border-t-0 md:border-t border-[#e2ece6]/20 mt-0 md:mt-auto flex justify-center items-center w-auto md:w-full shrink-0">
          <button
            id="theme-toggle-btn"
            onClick={toggleTheme}
            className="flex items-center justify-center p-0 text-xs font-mono lcd-button rounded-none cursor-pointer font-black"
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`}
            aria-label="Toggle Dark / Light Theme"
          >
            {theme === 'dark' ? (
              <Sun className="w-5 h-5 text-amber-400" />
            ) : (
              <Moon className="w-5 h-5" />
            )}
          </button>
        </div>
      </aside>

      {/* Right Column (Main Stage) */}
      <main className="main-stage">
        {/* Main Stage Top Status Bar */}
        <header className="w-full bg-[#0d110f]/80 border-2 border-[#e2ece6]/30 p-2 sm:p-2.5 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <div className="md:hidden flex items-center gap-1.5 pr-2 border-r border-[#e2ece6]/20">
              <span className="text-base font-black font-mono tracking-widest text-[#e2ece6]">ECG</span>
            </div>
            <div>
              <div className="text-xs uppercase font-mono font-black text-[#00FF66] tracking-wider flex items-center gap-1.5">
                {activeTab === 'dashboard' && 'LIVE INSTRUMENT DASHBOARD'}
                {activeTab === 'graphs' && 'HISTORIC TELEMETRY CHANNELS'}
                {activeTab === 'telematics' && 'FLEET TELEMATICS & SERIAL DECK'}
                {activeTab === 'controls' && 'SYSTEM CONTROLS & DIAGNOSTICS'}
              </div>
              <p className="text-[9px] font-mono opacity-70">
                ACTIVE VEHICLE: <span className="font-bold text-[#e2ece6]">{activeTruck.name}</span> ({activeTruck.model})
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Quick Status Pill */}
            <div className={`flex items-center gap-1.5 border-2 px-2 py-0.5 text-[10px] font-mono font-black ${
              connectionStatus === 'connected'
                ? 'border-[#00FF66] text-[#00FF66]'
                : connectionStatus === 'simulator' || connectionStatus === 'connecting'
                ? 'border-[#FFCC00] text-[#FFCC00]'
                : 'border-[#FF0000] text-[#FF0000]'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                connectionStatus === 'connected'
                  ? 'bg-[#00FF66]'
                  : connectionStatus === 'simulator' || connectionStatus === 'connecting'
                  ? 'bg-[#FFCC00] animate-pulse'
                  : 'bg-[#FF0000]'
              }`} />
              <span>{connectionStatus.toUpperCase()}</span>
              {dataHz > 0 && <span className="ml-1 pl-1 border-l border-current">{dataHz} HZ</span>}
            </div>

            {/* Quick Connect / Disconnect */}
            {connectionStatus === 'disconnected' || connectionStatus === 'connecting' ? (
              <button
                onClick={handleConnect}
                disabled={connectionStatus === 'connecting'}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono lcd-button font-black cursor-pointer disabled:opacity-50 hover:border-[#00FF66] hover:text-[#00FF66]"
              >
                <Power className="w-3.5 h-3.5 text-[#00FF66]" />
                <span className="hidden sm:inline">CONNECT USB</span>
                <span className="sm:hidden">CONNECT</span>
              </button>
            ) : (
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono border-2 border-[#FF0000] text-[#FF0000] bg-[#0b0f0d] hover:bg-[#FF0000] hover:text-white font-black cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">DISCONNECT</span>
                <span className="sm:hidden">STOP</span>
              </button>
            )}

            <button
              onClick={downloadCSV}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono lcd-button font-black cursor-pointer"
              title="Save CSV Telemetry Log"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">SAVE CSV</span>
            </button>

            {/* Dedicated Mobile Header Theme Toggle Button */}
            <button
              id="mobile-header-theme-toggle"
              onClick={toggleTheme}
              className="flex md:hidden items-center justify-center w-7 h-7 text-xs font-mono border-2 border-[#e2ece6]/30 bg-[#0b0f0d] hover:border-[#00FF66] rounded-none cursor-pointer text-[#e2ece6] shrink-0"
              title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`}
              aria-label="Toggle Dark / Light Theme"
            >
              {theme === 'dark' ? (
                <Sun className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <Moon className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </header>

        {/* 2. Inline Telemetry Sensor Malfunction Warning Status Banner with Live MM:SS Stopwatch */}
        <AnimatePresence>
          {activeMalfunction && (
            <motion.div
              id="telemetry-malfunction-banner"
              initial={{ opacity: 0, scale: 0.96, y: -12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -12 }}
              transition={{ duration: 0.2 }}
              className="telemetry-malfunction-banner max-w-7xl w-full mx-auto mb-2 border-2 p-3 sm:p-3.5 flex flex-col md:flex-row items-center justify-between gap-3 text-center md:text-left select-none z-40"
              role="alert"
              aria-live="assertive"
            >
              <div className="flex items-center gap-3">
                <span className="text-2xl sm:text-3xl animate-pulse shrink-0">⚠️</span>
                <div className="space-y-0.5">
                  <div className="text-xs sm:text-sm font-black font-mono tracking-widest uppercase">
                    {activeMalfunction.headline}
                  </div>
                  <p className="text-[10px] sm:text-[11px] font-mono font-bold opacity-90 uppercase">
                    {activeMalfunction.details} • 10-SECOND SAFETY ESCALATION MONITORING ACTIVE
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                <div className="flex items-center gap-2 malfunction-stopwatch-box px-3 py-1 font-mono shadow-lg">
                  <span className="text-[9px] uppercase tracking-wider font-bold opacity-75 hidden sm:inline">
                    DURATION:
                  </span>
                  <span className="font-norwester font-black text-2xl sm:text-3xl leading-none tracking-widest">
                    {malfunctionStopwatch}
                  </span>
                  <span className="text-[10px] font-bold opacity-60">
                    / 00:10
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Error Alert Display */}
        <AnimatePresence>
          {errorAlert && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="max-w-7xl w-full mx-auto mb-2 bg-[#0b0f0d] border-2 border-[#FF0000] rounded-none p-2.5 sm:p-3 flex flex-col md:flex-row items-start justify-between gap-3 text-white"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-[#FF0000] flex-shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <h4 className="text-xs font-mono tracking-wider font-black text-[#FF0000]">USB CONNECTION ERROR</h4>
                  <p className="text-[11px] opacity-95 font-mono">
                    {errorAlert.message}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 self-end md:self-center">
                {errorAlert.isPermission && (
                  <a 
                    href={window.location.href} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="flex items-center gap-1 px-2.5 py-1 text-xs bg-[#FF0000] text-white border border-[#FF0000] hover:bg-[#CC0000] rounded-none transition-all font-mono font-black"
                  >
                    OPEN IN NEW TAB <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <button 
                  onClick={() => setErrorAlert(null)}
                  className="px-2.5 py-1 text-xs bg-[#0d110f] text-[#FF0000] border-2 border-[#FF0000] hover:bg-[#FF0000] hover:text-white rounded-none transition-all font-mono font-black cursor-pointer"
                >
                  DISMISS
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* View Container: Fleet Telematics Deck (Vehicle Profile, Baud Rate, Simulator & Status Badges) */}
        <div id="view-telematics" style={{ display: activeTab === 'telematics' ? 'block' : 'none' }}>
          {/* Fleet Telematics Control Deck */}
          <section className="controls max-w-7xl w-full mx-auto mb-2 bg-[#0d110f]/80 border-2 border-[#e2ece6]/30 rounded-none p-1.5 sm:p-2.5 flex flex-col gap-2">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-2 sm:gap-2.5">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-transparent border-2 border-[#e2ece6]/30 rounded-none flex items-center justify-center shrink-0">
              <Gauge className="w-4 h-4 text-[#e2ece6]" />
            </div>
            <div>
              <h2 className="text-xs font-mono uppercase tracking-widest font-black">Fleet Telematics Deck</h2>
              <p className="text-[9px] opacity-75 font-mono">Vehicle profile & stream telemetry config</p>
            </div>
          </div>

          {/* Vehicle Profile Selector & Web Serial Connection Area */}
          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-1.5 sm:gap-2 w-full lg:w-auto">
            {/* Truck Profile Dropdown Menu - Full width on mobile, truncated cleanly */}
            <div className="flex items-center gap-1.5 bg-[#0b0f0d] border-2 border-[#e2ece6] px-2 py-1 rounded-none text-[#e2ece6] w-full sm:w-auto max-w-full overflow-hidden">
              <Truck className="w-3.5 h-3.5 text-[#e2ece6] shrink-0" />
              <label htmlFor="vehicle-profile-select" className="text-[11px] font-mono uppercase font-black tracking-wider cursor-pointer whitespace-nowrap shrink-0">
                Profile:
              </label>
              <select
                id="vehicle-profile-select"
                value={selectedTruckId}
                onChange={(e) => handleProfileChange(e.target.value as any)}
                className="bg-[#0b0f0d] text-[#e2ece6] text-xs font-mono font-black outline-none cursor-pointer uppercase border-none focus:ring-0 py-0 w-full min-w-0 max-w-full truncate"
              >
                <option value="class8" className="bg-[#0d110f] text-[#e2ece6]">Class 8 Heavy Hauler (Peterbilt 579)</option>
                <option value="medium" className="bg-[#0d110f] text-[#e2ece6]">Medium Duty Delivery (Isuzu NPR)</option>
                <option value="light" className="bg-[#0d110f] text-[#e2ece6]">Light Duty Pickup (Ford F-150)</option>
              </select>
            </div>

            {/* Badges Container: Status & MQTT Badges wrap onto their own row on mobile */}
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-1.5 w-full sm:w-auto">
              {/* Semantic Status Indicator (Green for Connected, Red for Disconnected, Yellow for Simulating/Connecting) */}
              <div 
                id="connection-status-badge"
                className={`flex items-center justify-center gap-1.5 border-2 px-2 py-1 rounded-none font-mono flex-1 sm:flex-initial ${
                connectionStatus === 'connected'
                  ? 'status-badge-connected border-[#00FF66] bg-[#0b0f0d] text-[#00FF66] font-black'
                  : connectionStatus === 'simulator' || connectionStatus === 'connecting'
                  ? 'border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] font-black'
                  : 'status-badge-disconnected border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] font-black'
              }`}>
                <span className={`status-label text-[10px] uppercase font-black ${
                  connectionStatus === 'disconnected' ? 'text-[#FF0000]' : ''
                }`}>Status:</span>
                <div className="flex items-center gap-1">
                  {connectionStatus === 'disconnected' && (
                    <>
                      <span className="status-dot w-2 h-2 rounded-full bg-[#FF0000]" />
                      <span className="status-text text-xs uppercase font-black text-[#FF0000]">Disconnected</span>
                    </>
                  )}
                  {connectionStatus === 'connecting' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-[#FFCC00] animate-pulse" />
                      <span className="text-xs uppercase animate-pulse font-black text-[#FFCC00]">Connecting</span>
                    </>
                  )}
                  {connectionStatus === 'connected' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-[#00FF66]" />
                      <span className="text-xs uppercase font-black text-[#00FF66]">Connected</span>
                    </>
                  )}
                  {connectionStatus === 'simulator' && (
                    <>
                      <span className="w-2 h-2 rounded-full bg-[#FFCC00]" />
                      <span className="text-xs uppercase font-black text-[#FFCC00]">Simulating</span>
                    </>
                  )}
                </div>
                
                {dataHz > 0 && (
                  <div className="ml-1 pl-1 border-l-2 border-[#00FF66] text-[10px] font-black text-[#00FF66]">
                    {dataHz} HZ
                  </div>
                )}
              </div>

              {/* MQTT Cloud Bridge Status */}
              <div className={`flex items-center justify-center gap-1.5 border-2 px-2 py-1 rounded-none font-mono flex-1 sm:flex-initial ${
                mqttStatus === 'connected'
                  ? 'mqtt-badge-connected border-[#00FF66] bg-[#0b0f0d] text-[#00FF66] font-black'
                  : mqttStatus === 'connecting'
                  ? 'border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] font-black'
                  : 'border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] font-black'
              }`} title={`MQTT Broker: ${activeBrokerUrl} (Topic: ${SOS_TOPIC})`}>
                <Radio className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase font-black">MQTT:</span>
                <div className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-full ${
                    mqttStatus === 'connected'
                      ? 'bg-[#00FF66]'
                      : mqttStatus === 'connecting'
                      ? 'bg-[#FFCC00] animate-pulse'
                      : 'bg-[#FF0000]'
                  }`} />
                  <span className="text-xs uppercase font-black">{mqttStatus}</span>
                </div>
              </div>
            </div>

            {/* Baud Select & Simulator Controls: wrap cleanly */}
            <div className="flex items-center gap-1.5 w-full sm:w-auto">
              {/* Baud Select (Only if disconnected) */}
              {connectionStatus === 'disconnected' && (
                <div className="flex items-center justify-center gap-1 bg-transparent border-2 border-[#e2ece6]/30 px-2 py-1 rounded-none text-[#e2ece6] flex-1 sm:flex-initial">
                  <SlidersHorizontal className="w-3 h-3" />
                  <select
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    className="bg-transparent text-xs text-[#e2ece6] font-mono font-black outline-none cursor-pointer border-none py-0"
                    title="USB Baud Rate"
                  >
                    {STANDARD_BAUD_RATES.map((rate) => (
                      <option key={rate} value={rate} className="bg-[#0d110f] text-[#e2ece6]">
                        {rate} Baud
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Semantic Yellow Simulator Trigger with Dropdown Settings Menu */}
              <div className="relative inline-flex items-stretch flex-1 sm:flex-initial" ref={simDropdownRef}>
                {/* Primary Simulator Action Button */}
                <button
                  onClick={handleToggleSimulator}
                  className={`btn-simulator flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-mono tracking-wider transition-all duration-150 cursor-pointer rounded-none font-black flex-1 sm:flex-initial ${
                    connectionStatus === 'simulator' ? 'active' : ''
                  }`}
                  title={connectionStatus === 'simulator' ? 'Click to stop simulation' : 'Click to start simulation'}
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>{connectionStatus === 'simulator' ? 'SIMULATING' : 'SIMULATOR'}</span>
                  {connectionStatus === 'simulator' && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#0d110f] animate-ping" />
                  )}
                </button>

                {/* Dropdown Menu Toggle Trigger */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsSimMenuOpen(!isSimMenuOpen);
                  }}
                  className={`btn-simulator px-2 py-1.5 text-xs font-mono border-l-0 transition-all duration-150 cursor-pointer rounded-none font-black flex items-center justify-center ${
                    isSimMenuOpen ? 'active' : ''
                  } ${connectionStatus === 'simulator' ? 'active' : ''}`}
                  title="Simulation Settings & Profiles"
                  aria-label="Simulation Settings Menu"
                  aria-expanded={isSimMenuOpen}
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isSimMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {/* Simulation Settings Dropdown Menu */}
                <AnimatePresence>
                  {isSimMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 top-full mt-1.5 w-[calc(100vw-24px)] max-w-sm sm:w-96 bg-[#0b0f0d] border-2 border-[#FFCC00] p-2.5 sm:p-3 z-50 text-[#e2ece6] font-mono"
                    >
                    {/* Dropdown Header */}
                    <div className="flex items-center justify-between border-b-2 border-[#FFCC00]/40 pb-2 mb-2.5">
                      <div className="flex items-center gap-2">
                        <Sliders className="w-4 h-4 text-[#FFCC00]" />
                        <div>
                          <h3 className="text-xs uppercase tracking-wider font-mono font-black text-[#FFCC00]">
                            Simulation Settings
                          </h3>
                          <p className="text-[9px] text-[#FFCC00] font-mono">
                            ACTIVE: {simProfile.toUpperCase()} • {simHz} HZ
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setIsSimMenuOpen(false)}
                        className="p-1 text-[#FFCC00] hover:text-white hover:bg-[#FFCC00]/20 border border-[#FFCC00]/40 transition-colors cursor-pointer"
                        title="Close menu"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Master Simulator Start/Stop Action Button */}
                    <div className="mb-3">
                      {connectionStatus === 'simulator' ? (
                        <button
                          onClick={() => {
                            handleToggleSimulator();
                            setIsSimMenuOpen(false);
                          }}
                          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[#FF0000] hover:bg-[#CC0000] text-white font-mono font-black text-xs uppercase tracking-wider border-2 border-[#FF0000] cursor-pointer transition-all"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" />
                          <span>STOP SIMULATION</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            if (connectionStatus !== 'simulator') {
                              handleToggleSimulator();
                            }
                            setIsSimMenuOpen(false);
                          }}
                          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[#FFCC00] hover:bg-[#E6B800] text-[#0d110f] font-mono font-black text-xs uppercase tracking-wider border-2 border-[#FFCC00] cursor-pointer transition-all"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>START SIMULATION ({simProfile.toUpperCase()})</span>
                        </button>
                      )}
                    </div>

                    {/* Telemetry Drive Cycles / Profiles */}
                    <div className="space-y-1.5 mb-3">
                      <div className="flex items-center justify-between text-[10px] uppercase font-black text-amber-300/90 tracking-wider">
                        <span>Drive Cycle Profiles:</span>
                        <span className="text-[9px] text-[#e2ece6]/60">CLICK TO SELECT</span>
                      </div>

                      <div className="grid grid-cols-2 gap-1.5">
                        {[
                          { id: 'track', label: 'Racetrack Laps', tag: 'CIRCUIT', desc: 'Dynamic gear sweep & downshift blips' },
                          { id: 'drag', label: 'Drag Strip', tag: 'W.O.T.', desc: 'Full throttle launch & speed governor' },
                          { id: 'cruise', label: 'Highway Cruise', tag: 'STEADY', desc: '65-72 MPH steady overdrive cruise' },
                          { id: 'overheat', label: 'Coolant Failure', tag: 'OVERHEAT', desc: 'Thermal stress ramp > 115°C alert' }
                        ].map((prof) => (
                          <button
                            key={prof.id}
                            onClick={() => {
                              setSimProfile(prof.id as any);
                              addLog(`Simulation drive cycle set to: ${prof.label}`);
                            }}
                            className={`p-2 border-2 text-left flex flex-col justify-between transition-all duration-150 cursor-pointer rounded-none ${
                              simProfile === prof.id
                                ? 'border-[#FFCC00] bg-[#FFCC00] text-[#0d110f] font-black'
                                : 'border-[#e2ece6]/30 bg-[#0d110f] text-[#e2ece6] hover:border-[#FFCC00] hover:text-[#FFCC00]'
                            }`}
                          >
                            <div className="flex items-center justify-between w-full mb-1">
                              <span className="text-[10px] font-mono block font-black leading-none">{prof.label}</span>
                              <span className={`text-[7px] px-1 py-0.2 border ${simProfile === prof.id ? 'border-[#0d110f] text-[#0d110f]' : 'border-[#FFCC00]/60 text-[#FFCC00]'}`}>
                                {prof.tag}
                              </span>
                            </div>
                            <span className={`text-[8px] leading-tight font-mono ${simProfile === prof.id ? 'text-[#0d110f]/90' : 'opacity-70'}`}>
                              {prof.desc}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Stream Frequency / Hz Selection */}
                    <div className="border-t border-amber-400/20 pt-2 mb-2.5">
                      <div className="flex items-center justify-between text-[10px] uppercase font-black text-amber-300/90 mb-1.5">
                        <span>Simulation Frequency (Rate):</span>
                        <span className="text-[#FFCC00] font-black">{simHz} HZ</span>
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {[
                          { hz: 10, label: '10 Hz (100ms)' },
                          { hz: 4, label: '4 Hz (250ms)' },
                          { hz: 1, label: '1 Hz (1000ms)' }
                        ].map((opt) => (
                          <button
                            key={opt.hz}
                            onClick={() => {
                              setSimHz(opt.hz);
                              addLog(`Simulation update frequency set to: ${opt.hz} Hz`);
                            }}
                            className={`py-1 text-[9px] font-mono font-black border-2 transition-all cursor-pointer ${
                              simHz === opt.hz
                                ? 'bg-[#FFCC00] text-[#0d110f] border-[#FFCC00]'
                                : 'bg-[#0d110f] text-[#e2ece6] border-[#e2ece6]/30 hover:border-[#FFCC00] hover:text-[#FFCC00]'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Quick Hardware Fault Injection */}
                    <div className="border-t border-amber-400/20 pt-2 mb-2">
                      <span className="text-[10px] uppercase font-black text-amber-300/90 block mb-1.5">
                        Hardware Sensor Fault Injection:
                      </span>
                      <div className="grid grid-cols-3 gap-1 mb-1.5">
                        <button
                          onClick={() => {
                            triggerTestTempAnomaly();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-[#0d110f] transition-all text-center cursor-pointer"
                          title="Simulates Coolant Temp pin anomaly: Reading >= 120 °C"
                        >
                          Temp ≥ 120°C
                        </button>
                        <button
                          onClick={() => {
                            triggerTestSpeedAnomaly();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-[#0d110f] transition-all text-center cursor-pointer"
                          title="Simulates Vehicle Speed dropped to 0 while Engine Load > 20%"
                        >
                          Spd 0 (Load&gt;20)
                        </button>
                        <button
                          onClick={() => {
                            triggerTestThrottleAnomaly();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-[#0d110f] transition-all text-center cursor-pointer"
                          title="Simulates Throttle Position sensor anomaly: Reading > 100%"
                        >
                          Throttle &gt; 100%
                        </button>
                        <button
                          onClick={() => {
                            triggerTestLoadAnomaly();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-[#0d110f] transition-all text-center cursor-pointer"
                          title="Simulates Engine Load sensor anomaly: Reading >= 98%"
                        >
                          Load ≥ 98%
                        </button>
                        <button
                          onClick={() => {
                            triggerClearFault();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#00FF66] bg-[#0b0f0d] text-[#00FF66] hover:bg-[#00FF66] hover:text-black transition-all text-center cursor-pointer"
                          title="Simulates jumper wire removal: returns sensor telemetry to normal limits"
                        >
                          Clear (Remove Wire)
                        </button>
                        <button
                          onClick={() => {
                            triggerFastForward60s();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] hover:bg-[#FF0000] hover:text-white transition-all text-center cursor-pointer"
                          title="Fast-forwards stopwatch to 60s threshold to trigger critical malfunction escalation"
                        >
                          60s Escalation
                        </button>
                      </div>
                      <div className="grid grid-cols-1 gap-1">
                        <button
                          onClick={() => {
                            triggerTestGForce();
                            setIsSimMenuOpen(false);
                          }}
                          className="py-1 px-1 text-[8px] font-mono font-black border-2 border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] hover:bg-[#FF0000] hover:text-white transition-all text-center cursor-pointer"
                          title="Simulates mobile accelerometer shock event (> 25 m/s²)"
                        >
                          💥 Shock &gt; 25 m/s² (Accelerometer Crash)
                        </button>
                      </div>
                    </div>

                    {/* Active Vehicle & Reset */}
                    <div className="border-t border-[#e2ece6]/15 pt-2 flex items-center justify-between text-[9px] text-[#e2ece6]/70">
                      <span>FLEET: <strong className="text-amber-400 font-black">{activeTruck.name}</strong></span>
                      <button
                        onClick={() => {
                          simStateRef.current = {
                            rpm: 750,
                            speed: 0,
                            temp: 82.0,
                            throttle: 0,
                            load: 15,
                            gear: 1,
                            time: 0,
                            shifting: false,
                            shiftTimer: 0
                          };
                          addLog('Simulation engine physics reset to idle.');
                        }}
                        className="underline hover:text-amber-300 cursor-pointer font-black"
                      >
                        Reset Physics
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>

      {/* View Container: Live Dashboard (5 Clean Numerical Gauges & Dedicated Lower Graph Stage) */}
      <div id="view-dashboard" style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }}>
        {/* 1. Clean 5-Card Telemetry Grid (ENGINE SPEED, VEHICLE SPEED, COOLANT TEMP, THROTTLE POS, ENGINE LOAD) */}
        <div className="telemetry-grid max-w-7xl w-full mx-auto mb-3">
          {/* Card 1: Engine Speed */}
          <DigitalCard
            id="card-engine-speed"
            label="ENGINE SPEED"
            value={isConnected ? Math.round(telemetry.rpm) : (isSimulator ? Math.round(telemetry.rpm) : 0)}
            min={0}
            max={activeTruck.redlineRpm}
            unit="RPM"
            alert={Boolean((isConnected || isSimulator) && isRpmAlert)}
            alertThreshold={activeTruck.rpmWarning}
            onClick={() => handleSelectMetric('rpm')}
            isSelected={selectedDashboardMetric === 'rpm'}
            extraBadge="CRANKSHAFT FREQ"
          />

          {/* Card 2: Vehicle Speed */}
          <DigitalCard
            id="card-vehicle-speed"
            label="VEHICLE SPEED"
            value={isConnected ? dispSpeed : (isSimulator ? dispSpeed : 0)}
            min={0}
            max={speedUnit === 'KMH' ? activeTruck.maxSpeedKmh : activeTruck.maxSpeedMph}
            unit={speedUnit}
            alert={Boolean((isConnected || isSimulator) && isSpeedAlert)}
            alertThreshold={speedUnit === 'KMH' ? activeTruck.maxSpeedKmh : activeTruck.maxSpeedMph}
            onClick={() => handleSelectMetric('speed')}
            isSelected={selectedDashboardMetric === 'speed'}
            extraBadge="GROUND VELOCITY"
          />

          {/* Card 3: Coolant Temp */}
          <DigitalCard
            id="card-coolant-temp"
            label="COOLANT TEMP"
            value={isConnected ? dispTemp : (isSimulator ? dispTemp : 0)}
            min={tempUnit === 'F' ? 32 : 0}
            max={tempUnit === 'F' ? 266 : 130}
            unit={`°${tempUnit}`}
            alert={Boolean((isConnected || isSimulator) && isTempAlert)}
            alertThreshold={tempUnit === 'F' ? 203 : thresholds.tempWarning}
            onClick={() => handleSelectMetric('temp')}
            isSelected={selectedDashboardMetric === 'temp'}
            extraBadge="THERMAL CORE"
          />

          {/* Card 4: Throttle Pos */}
          <DigitalCard
            id="card-throttle-pos"
            label="THROTTLE POS"
            value={isConnected ? Math.round(telemetry.throttle) : (isSimulator ? Math.round(telemetry.throttle) : 0)}
            min={0}
            max={100}
            unit="%"
            alert={Boolean((isConnected || isSimulator) && isThrottleAlert)}
            alertThreshold={85}
            onClick={() => handleSelectMetric('throttle')}
            isSelected={selectedDashboardMetric === 'throttle'}
            extraBadge="PEDAL DEMAND"
          />

          {/* Card 5: Engine Load */}
          <DigitalCard
            id="card-engine-load"
            label="ENGINE LOAD"
            value={isConnected ? Math.round(telemetry.load) : (isSimulator ? Math.round(telemetry.load) : 0)}
            min={0}
            max={100}
            unit="%"
            alert={Boolean((isConnected || isSimulator) && isLoadAlert)}
            alertThreshold={85}
            onClick={() => handleSelectMetric('load')}
            isSelected={selectedDashboardMetric === 'load'}
            extraBadge="TORQUE DEMAND"
          />
        </div>

        {/* 2. Dedicated Full-Width Graph Container Below Grid */}
        {(() => {
          const activeCfg = getMetricConfig(selectedDashboardMetric);
          return (
            <div
              id="dashboard-graph-stage"
              className={`max-w-7xl w-full mx-auto p-3 sm:p-4 rounded-none transition-all duration-200 ${
                activeCfg.alert ? 'is-alert' : 'is-active'
              }`}
            >
              {/* Graph Stage Header with Active Metric Details & Quick Metric Selectors */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2.5 mb-2 border-b border-[#e2ece6]/15 gap-2">
                <div className="flex items-center gap-2">
                  <div className={`p-1 border ${
                    activeCfg.alert
                      ? 'border-[#FF0000] bg-[#FF0000]/10 text-[#FF0000]'
                      : 'border-[#00FF66] bg-[#00FF66]/10 text-[#00FF66]'
                  }`}>
                    <TrendingUp className="w-4 h-4 stroke-[2.5]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs sm:text-sm font-black tracking-wider uppercase font-mono text-[#00FF66]">
                        {activeCfg.label}
                      </span>
                      <span className="text-[8.5px] font-mono px-1.5 py-0.2 bg-[#00FF66] text-[#000000] font-black uppercase tracking-wider">
                        LIVE TIMELINE
                      </span>
                      {activeCfg.alert && (
                        <span className="text-[8.5px] font-mono px-1.5 py-0.2 bg-[#FF0000] text-white font-black uppercase tracking-wider flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          WARNING LIMIT EXCEEDED
                        </span>
                      )}
                    </div>
                    <p className="text-[9px] font-mono opacity-60 uppercase text-[#e2ece6] mt-0.5">
                      REAL-TIME CONTINUOUS WAVEFORM • {historyCapacity} SAMPLE BUFFER WINDOW
                    </p>
                  </div>
                </div>

                {/* Quick Channel Selection Tabs */}
                <div className="flex items-center gap-1 flex-wrap">
                  {(['rpm', 'speed', 'temp', 'throttle', 'load'] as const).map((mKey) => {
                    const cfg = getMetricConfig(mKey);
                    const isCurrent = selectedDashboardMetric === mKey;
                    return (
                      <button
                        key={mKey}
                        onClick={() => handleSelectMetric(mKey)}
                        className={`text-[8.5px] font-mono uppercase px-2 py-1 font-black transition-all border cursor-pointer ${
                          isCurrent
                            ? 'bg-[#00FF66] text-[#000000] border-[#00FF66] shadow-[0_0_8px_rgba(0,255,102,0.4)]'
                            : 'bg-transparent text-[#e2ece6]/70 border-[#e2ece6]/20 hover:border-[#00FF66]/60 hover:text-[#00FF66]'
                        }`}
                      >
                        {cfg.label.replace('ENGINE ', '').replace('VEHICLE ', '')}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Dedicated High-DPI Real-time Canvas Stage */}
              <div className="stage-canvas-wrapper relative w-full border border-[#e2ece6]/20 overflow-hidden">
                <canvas id="canvas-dashboard-stage" className="w-full h-full block" />
              </div>

              {/* Lower Stage Telemetry Status Bar */}
              <div className="flex items-center justify-between text-[8.5px] sm:text-[9px] font-mono uppercase pt-2 mt-1 border-t border-[#e2ece6]/10 text-[#e2ece6]/70">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-[#00FF66]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00FF66] animate-pulse" />
                    STREAMING AT 20HZ
                  </span>
                  <span>CURRENT: <strong className="text-[#00FF66] font-mono">{activeCfg.currentValue}</strong></span>
                  {activeCfg.alertThreshold && (
                    <span className="text-[#FF0000]">WARN LIMIT: {activeCfg.alertThreshold} {activeCfg.unit}</span>
                  )}
                </div>
                <div className="hidden sm:flex items-center gap-2">
                  <span>CLICK ANY TOP CARD TO SWITCH TELEMETRY STREAM</span>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* View Container: Telemetry Graphs (4 Rolling Canvas Charts) */}
      <div id="view-graphs" style={{ display: activeTab === 'graphs' ? 'block' : 'none' }}>
        {/* 4-Window Rolling Graphs Section */}
        <section className="max-w-7xl w-full mx-auto mb-2">
          <div className="bg-[#0d110f]/80 border-2 border-[#e2ece6]/30 rounded-none p-2 sm:p-2.5 mb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-[#00FF66]" />
              <h2 className="text-xs uppercase tracking-wider font-mono font-black">Independent Rolling Telemetry Channels</h2>
            </div>
            <span className="text-[10px] font-mono uppercase font-black text-[#00FF66]">4-CHANNEL ROLLING BUFFER ({historyCapacity} SAMPLE WINDOW)</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-2.5">
            <MetricTimelineChart
              label="Engine RPM"
              data={history.rpm}
              timestamps={history.timestamps}
              minY={0}
              maxY={activeTruck.chartMaxRpm}
              unit="RPM"
              color="#ffffff"
              alert={isRpmAlert}
              alertThreshold={activeTruck.rpmWarning}
            />

            <MetricTimelineChart
              label="Vehicle Speed"
              data={history.speed.map(s => speedUnit === 'KMH' ? s * 1.60934 : s)}
              timestamps={history.timestamps}
              minY={0}
              maxY={speedUnit === 'KMH' ? activeTruck.maxSpeedKmh : activeTruck.maxSpeedMph}
              unit={speedUnit}
              color="#ffffff"
              alert={isSpeedAlert}
              alertThreshold={speedUnit === 'KMH' ? activeTruck.maxSpeedKmh : activeTruck.maxSpeedMph}
            />

            <MetricTimelineChart
              label="Coolant Temp"
              data={history.temp.map(t => tempUnit === 'F' ? (t * 9) / 5 + 32 : t)}
              timestamps={history.timestamps}
              minY={tempUnit === 'F' ? 32 : 0}
              maxY={tempUnit === 'F' ? 266 : 130}
              unit={`°${tempUnit}`}
              color="#ffffff"
              alert={isTempAlert}
              alertThreshold={tempUnit === 'F' ? 203 : thresholds.tempWarning}
            />

            <MetricTimelineChart
              label="Engine Load"
              data={history.load}
              timestamps={history.timestamps}
              minY={0}
              maxY={100}
              unit="%"
              color="#ffffff"
              alert={isLoadAlert}
              alertThreshold={85}
            />
          </div>
        </section>
      </div>

      {/* View Container: Dashboard Controls & Settings (Crash SOS Protocol, Data Export, Capacity, Unit Toggles, Diagnostics) */}
      <div id="view-controls" style={{ display: activeTab === 'controls' ? 'block' : 'none' }}>
        {/* Crash Detection SOS Protocol Panel */}
        <section 
          id="crash-detection-sos-protocol-panel"
          className="crash-detection-panel max-w-7xl w-full mx-auto mb-2 bg-[#0b0f0d] border-2 border-[#FF0000] rounded-none p-1.5 sm:p-2.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-2 overflow-hidden"
        >
          <div className="flex items-center gap-2 sm:gap-2.5 w-full md:w-auto">
            <div className="crash-shield-icon-wrapper p-1.5 border-2 border-[#FF0000] bg-[#000000] rounded-none flex items-center justify-center shrink-0">
              <ShieldAlert className="crash-shield-icon w-4 h-4 text-[#FF0000]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <h2 className="crash-header-text text-xs font-mono uppercase tracking-wider font-black text-[#FF0000]">
                  Crash Detection SOS Protocol
                </h2>
                <span className="badge-dual-redundant text-[9px] font-mono px-1.5 py-0.5 border-2 border-[#FF0000] bg-[#FF0000] text-[#FFFFFF] font-black uppercase">
                  Dual-Redundant
                </span>
              </div>
              <p className="text-[10px] font-mono text-[#e2ece6] mt-0.5 truncate sm:whitespace-normal">
                Impact: Accelerometer &gt; 100 m/s² • Sensor Malfunctions: Temp ≥ 120°C, Spd 0 (Load&gt;20), Throttle, Load (10s Escalate) • MQTT: <code className="text-[#FF0000] font-black">ecg/fleet/truck04/sos</code>
              </p>
            </div>
          </div>

          {/* Rapid Test Triggers with guaranteed wrapping */}
          <div className="flex flex-wrap items-center gap-1.5 w-full md:w-auto pt-1 md:pt-0">
            <span className="test-sos-label text-[10px] font-mono uppercase text-[#FF0000] font-black mr-0.5 w-full sm:w-auto">Test:</span>
            <button
              onClick={triggerTestGForce}
              className="btn-test-sos flex-1 sm:flex-initial px-2 py-1 text-[10px] font-mono uppercase tracking-wider border-2 border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] hover:bg-[#FF0000] hover:text-white transition-all rounded-none cursor-pointer font-black text-center"
              title="Simulates devicemotion accelerometer shock event > 100 m/s² (Triggers VEHICLE IMPACT DETECTED)"
            >
              💥 Shock &gt; 100
            </button>
            <button
              onClick={triggerTestTempAnomaly}
              className="btn-test-sos flex-1 sm:flex-initial px-2 py-1 text-[10px] font-mono uppercase tracking-wider border-2 border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-black transition-all rounded-none cursor-pointer font-black text-center"
              title="Simulates Coolant Temp pin anomaly >= 120°C (Starts stopwatch)"
            >
              Temp ≥ 120°C
            </button>
            <button
              onClick={triggerTestSpeedAnomaly}
              className="btn-test-sos flex-1 sm:flex-initial px-2 py-1 text-[10px] font-mono uppercase tracking-wider border-2 border-[#FFCC00] bg-[#0b0f0d] text-[#FFCC00] hover:bg-[#FFCC00] hover:text-black transition-all rounded-none cursor-pointer font-black text-center"
              title="Simulates Vehicle Speed drop to 0 with Load > 20% (Starts stopwatch)"
            >
              Spd 0 (Load&gt;20)
            </button>
            <button
              onClick={triggerClearFault}
              className="btn-test-sos flex-1 sm:flex-initial px-2 py-1 text-[10px] font-mono uppercase tracking-wider border-2 border-[#00FF66] bg-[#0b0f0d] text-[#00FF66] hover:bg-[#00FF66] hover:text-black transition-all rounded-none cursor-pointer font-black text-center"
              title="Simulates jumper wire removal: returns sensor data to normal limits, clearing banner & resetting stopwatch"
            >
              ✓ Clear Fault
            </button>
            <button
              onClick={triggerFastForward60s}
              className="btn-test-sos flex-1 sm:flex-initial px-2 py-1 text-[10px] font-mono uppercase tracking-wider border-2 border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] hover:bg-[#FF0000] hover:text-white transition-all rounded-none cursor-pointer font-black text-center"
              title="Fast-forwards active stopwatch to 10s escalation threshold (Triggers CRITICAL SYSTEM TELEMETRY MALFUNCTION DETECTED)"
            >
              ⚡ 10s Escalate
            </button>
            <button
              onClick={triggerTestCloudMqtt}
              className="btn-test-sos flex-1 sm:flex-initial px-2 py-1 text-[10px] font-mono uppercase tracking-wider border-2 border-[#FF0000] bg-[#0b0f0d] text-[#FF0000] hover:bg-[#FF0000] hover:text-white transition-all rounded-none cursor-pointer font-black text-center"
              title="Publishes emergency message to MQTT cloud topic ecg/fleet/truck04/sos"
            >
              Cloud MQTT
            </button>
          </div>
        </section>

        {/* Dashboard Control Menu */}
        <section className="max-w-7xl w-full mx-auto mb-2 bg-[#0d110f]/80 border-2 border-[#e2ece6]/30 rounded-none p-1.5 sm:p-2.5">
          <div className="flex items-center gap-2 mb-2 border-b border-[#e2ece6]/20 pb-1.5">
            <Settings className="w-3.5 h-3.5" />
            <h2 className="text-xs uppercase tracking-wider font-mono font-black">Settings & Dashboard Controls</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-1.5 sm:gap-2 items-center">
            {/* Buffer Size option */}
            <div className="flex items-center justify-between md:justify-start md:gap-3 border border-[#e2ece6]/20 p-2 font-mono">
              <span className="text-[11px] uppercase font-black">Capacity</span>
              <div className="bg-transparent border border-[#e2ece6]/30 px-1.5 py-0.5 flex items-center ml-auto">
                <select
                  value={historyCapacity}
                  onChange={(e) => setHistoryCapacity(Number(e.target.value))}
                  className="bg-transparent text-xs text-[#e2ece6] font-mono font-black outline-none cursor-pointer border-none py-0"
                >
                  {HISTORY_CAPACITY_OPTIONS.map((cap) => (
                    <option key={cap} value={cap} className="bg-[#0d110f] text-[#e2ece6]">
                      {cap} smp
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Temp toggle */}
            <div className="flex items-center justify-between md:justify-start md:gap-3 border border-[#e2ece6]/20 p-2 font-mono">
              <span className="text-[11px] uppercase font-black">Temp Unit</span>
              <div className="bg-transparent border border-[#e2ece6]/30 p-0.5 rounded-none flex gap-1 ml-auto">
                <button
                  onClick={() => setTempUnit('C')}
                  className={`px-2 py-0.5 text-xs font-mono font-black transition-all rounded-none ${tempUnit === 'C' ? 'bg-[#e2ece6] text-[#0d110f]' : 'bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6]/10'}`}
                >
                  °C
                </button>
                <button
                  onClick={() => setTempUnit('F')}
                  className={`px-2 py-0.5 text-xs font-mono font-black transition-all rounded-none ${tempUnit === 'F' ? 'bg-[#e2ece6] text-[#0d110f]' : 'bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6]/10'}`}
                >
                  °F
                </button>
              </div>
            </div>

            {/* Speed toggle */}
            <div className="flex items-center justify-between md:justify-start md:gap-3 border border-[#e2ece6]/20 p-2 font-mono">
              <span className="text-[11px] uppercase font-black">Velocity</span>
              <div className="bg-[#0d110f] border border-[#e2ece6]/30 p-0.5 rounded-none flex gap-1 ml-auto">
                <button
                  onClick={() => setSpeedUnit('MPH')}
                  className={`px-2 py-0.5 text-xs font-mono font-black transition-all rounded-none ${speedUnit === 'MPH' ? 'bg-[#e2ece6] text-[#0d110f]' : 'bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6]/10'}`}
                >
                  MPH
                </button>
                <button
                  onClick={() => setSpeedUnit('KMH')}
                  className={`px-2 py-0.5 text-xs font-mono font-black transition-all rounded-none ${speedUnit === 'KMH' ? 'bg-[#e2ece6] text-[#0d110f]' : 'bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6]/10'}`}
                >
                  KMH
                </button>
              </div>
            </div>

            {/* Autoscale toggle */}
            <div className="flex items-center justify-between md:justify-start md:gap-3 border border-[#e2ece6]/20 p-2 font-mono">
              <span className="text-[11px] uppercase font-black">Auto Y-Axis</span>
              <button
                onClick={() => setAutoScaleY(!autoScaleY)}
                className="border border-[#e2ece6] px-2.5 py-0.5 font-mono font-black text-xs bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6] hover:text-[#0d110f] transition-all ml-auto"
              >
                {autoScaleY ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={downloadCSV}
                className="flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-mono font-black border-2 border-[#e2ece6] bg-[#0d110f] hover:bg-[#e2ece6] hover:text-[#0d110f] text-[#e2ece6] transition-all rounded-none cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                EXPORT CSV
              </button>
              <button
                onClick={handleResetSession}
                className="flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-mono font-black border-2 border-[#e2ece6] bg-[#0d110f] hover:bg-[#e2ece6] hover:text-[#0d110f] text-[#e2ece6] transition-all rounded-none cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                CLEAR DATA
              </button>
            </div>
          </div>
        </section>

      {/* Control Panel Bento Center (Compact & Dense) */}
      <section className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-2 sm:gap-2.5 mb-2">
        {/* Left Area: Session Analytics Table (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-2 sm:gap-2.5 w-full max-w-full overflow-hidden">
          {/* Analytical Metrics Card */}
          <div className="bg-[#0d110f]/80 border-2 border-[#e2ece6]/30 rounded-none p-1.5 sm:p-2.5 w-full max-w-full overflow-hidden">
            <div className="flex items-center justify-between mb-2 border-b border-[#e2ece6]/20 pb-1.5">
              <div className="flex items-center gap-2">
                <Sliders className="w-3.5 h-3.5" />
                <h2 className="text-xs uppercase tracking-wider font-mono font-black">Session Statistics Recall</h2>
              </div>
              <span className="text-[10px] font-mono font-black text-[#00FF66]">RECORDS: {stats.rpm.count.toLocaleString()}</span>
            </div>

            <div className="overflow-x-auto w-full max-w-full">
              <table className="w-full text-left border-collapse font-mono min-w-[320px] sm:min-w-full">
                <thead>
                  <tr className="border-b border-[#e2ece6]/30 text-[#e2ece6] opacity-90 text-[10px] uppercase font-black">
                    <th className="py-1.5 pr-3">Metric Channel</th>
                    <th className="py-1.5 px-3">Minimum</th>
                    <th className="py-1.5 px-3">Maximum</th>
                    <th className="py-1.5 pl-3">Session Avg</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e2ece6]/10 text-xs font-black">
                  
                  {/* RPM Row */}
                  <tr>
                    <td className="py-1.5 pr-3 text-[#e2ece6] font-black">
                      ENGINE SPEED
                    </td>
                    <td className="py-1.5 px-3 text-[#e2ece6] opacity-90 font-black">{stats.rpm.min !== null ? `${stats.rpm.min.toLocaleString()} RPM` : '--'}</td>
                    <td className="py-1.5 px-3 text-[#e2ece6] font-black">{stats.rpm.max !== null ? `${stats.rpm.max.toLocaleString()} RPM` : '--'}</td>
                    <td className="py-1.5 pl-3 text-[#e2ece6] opacity-90 font-black">
                      {stats.rpm.count > 0 ? `${Math.round(stats.rpm.sum / stats.rpm.count).toLocaleString()} RPM` : '--'}
                    </td>
                  </tr>

                  {/* Speed Row */}
                  <tr>
                    <td className="py-1.5 pr-3 text-[#e2ece6] font-black">
                      VEHICLE SPEED
                    </td>
                    <td className="py-1.5 px-3 text-[#e2ece6] opacity-90 font-black">{stats.speed.min !== null ? `${displaySpeed(stats.speed.min)} ${speedUnit}` : '--'}</td>
                    <td className="py-1.5 px-3 text-[#e2ece6] font-black">{stats.speed.max !== null ? `${displaySpeed(stats.speed.max)} ${speedUnit}` : '--'}</td>
                    <td className="py-1.5 pl-3 text-[#e2ece6] opacity-90 font-black">
                      {stats.speed.count > 0 ? `${displaySpeed(stats.speed.sum / stats.speed.count)} ${speedUnit}` : '--'}
                    </td>
                  </tr>

                  {/* Temp Row */}
                  <tr>
                    <td className="py-1.5 pr-3 text-[#e2ece6] font-black">
                      COOLANT TEMP
                    </td>
                    <td className="py-1.5 px-3 text-[#e2ece6] opacity-90 font-black">{stats.temp.min !== null ? `${displayTemp(stats.temp.min)}°${tempUnit}` : '--'}</td>
                    <td className="py-1.5 px-3 text-[#e2ece6] font-black">{stats.temp.max !== null ? `${displayTemp(stats.temp.max)}°${tempUnit}` : '--'}</td>
                    <td className="py-1.5 pl-3 text-[#e2ece6] opacity-90 font-black">
                      {stats.temp.count > 0 ? `${displayTemp(stats.temp.sum / stats.temp.count)}°${tempUnit}` : '--'}
                    </td>
                  </tr>

                  {/* Throttle Row */}
                  <tr>
                    <td className="py-1.5 pr-3 text-[#e2ece6] font-black">
                      THROTTLE POS
                    </td>
                    <td className="py-1.5 px-3 text-[#e2ece6] opacity-90 font-black">{stats.throttle.min !== null ? `${Math.round(stats.throttle.min)}%` : '--'}</td>
                    <td className="py-1.5 px-3 text-[#e2ece6] font-black">{stats.throttle.max !== null ? `${Math.round(stats.throttle.max)}%` : '--'}</td>
                    <td className="py-1.5 pl-3 text-[#e2ece6] opacity-90 font-black">
                      {stats.throttle.count > 0 ? `${Math.round(stats.throttle.sum / stats.throttle.count)}%` : '--'}
                    </td>
                  </tr>

                  {/* Engine Load Row */}
                  <tr>
                    <td className="py-1.5 pr-3 text-[#e2ece6] font-black">
                      ENGINE LOAD
                    </td>
                    <td className="py-1.5 px-3 text-[#e2ece6] opacity-90 font-black">{stats.load.min !== null ? `${Math.round(stats.load.min)}%` : '--'}</td>
                    <td className="py-1.5 px-3 text-[#e2ece6] font-black">{stats.load.max !== null ? `${Math.round(stats.load.max)}%` : '--'}</td>
                    <td className="py-1.5 pl-3 text-[#e2ece6] opacity-90 font-black">
                      {stats.load.count > 0 ? `${Math.round(stats.load.sum / stats.load.count)}%` : '--'}
                    </td>
                  </tr>

                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Area: Log Console Terminal (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-2 sm:gap-2.5 w-full max-w-full overflow-hidden">
          {/* Collapsible Serial Console Monitor */}
          <div className="bg-[#0d110f]/80 border-2 border-[#e2ece6]/30 rounded-none overflow-hidden w-full max-w-full">
            <button
              onClick={() => setIsConsoleOpen(!isConsoleOpen)}
              className="w-full flex items-center justify-between px-3 py-2 bg-transparent border-b border-[#e2ece6]/30 text-left outline-none cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5" />
                <span className="text-xs uppercase tracking-wider font-mono font-black">Diagnostics Console Terminal</span>
                <span className="text-[9px] border border-[#e2ece6]/30 text-[#e2ece6] px-1.5 py-0.5 font-mono font-black">
                  {consoleLogs.length} lines
                </span>
              </div>
              {isConsoleOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            <AnimatePresence initial={false}>
              {isConsoleOpen && (
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: 'auto' }}
                  exit={{ height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden w-full max-w-full"
                >
                  <div className="p-2 sm:p-4 bg-[#0d110f]/30 border-t border-[#e2ece6]/30 flex flex-col gap-2.5 sm:gap-3 w-full max-w-full overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2.5 bg-transparent p-2 rounded-none border border-[#e2ece6]/30">
                      
                      {/* Log Channel Selectors */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-mono uppercase pl-1.5 opacity-80">Filter:</span>
                        <div className="bg-transparent p-0.5 border border-[#e2ece6]/30 rounded-none flex gap-1">
                          {[
                            { id: 'all', label: 'All logs' },
                            { id: 'system', label: 'System only' },
                            { id: 'data', label: 'Raw RX' }
                          ].map((ch) => (
                            <button
                              key={ch.id}
                              onClick={() => setLogFilter(ch.id as any)}
                              className={`px-2 py-0.5 text-[10px] font-mono rounded-none ${logFilter === ch.id ? 'bg-[#e2ece6] text-[#0d110f]' : 'bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6]/10'}`}
                            >
                              {ch.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Log Action Buttons */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setIsConsoleActive(!isConsoleActive)}
                          className={`flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono transition-colors rounded-none border ${
                            isConsoleActive 
                              ? 'bg-[#e2ece6] text-[#0d110f] border-[#e2ece6]' 
                              : 'bg-[#0d110f] text-[#e2ece6] border-[#e2ece6]/30 hover:bg-[#e2ece6]/20'
                          }`}
                        >
                          {isConsoleActive ? '● Streaming' : '|| Paused'}
                        </button>
                        <button
                          onClick={() => setConsoleLogs([])}
                          className="px-2.5 py-1 text-[10px] font-mono bg-[#0d110f] border border-[#e2ece6]/30 hover:bg-[#e2ece6] hover:text-[#0d110f] text-[#e2ece6] rounded-none cursor-pointer"
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    {/* Console Screen */}
                    <div className="bg-[#0d110f]/60 border border-[#e2ece6]/30 p-3 rounded-none h-48 font-mono text-[11px] overflow-y-auto leading-relaxed text-[#e2ece6] select-all flex flex-col gap-1">
                      {filteredLogs.length === 0 ? (
                        <div className="text-[#e2ece6] opacity-50 text-center py-12 italic">
                          Console idle. Standard input streams will output here.
                        </div>
                      ) : (
                        filteredLogs.map((log, index) => {
                          const isError = log.includes('failed') || log.includes('Error') || log.includes('severed');
                          const isSuccess = log.includes('established') || log.includes('completed') || log.includes('success');
                          const isData = log.includes('[DATA]');

                          let lineClass = 'text-[#e2ece6]';
                          if (isError) lineClass = 'text-[#e2ece6] border-l-2 border-[#e2ece6] pl-1.5';
                          else if (isSuccess) lineClass = 'text-[#e2ece6] underline';
                          else if (isData) lineClass = 'text-[#e2ece6] opacity-60';

                          return (
                            <div key={index} className={`${lineClass} border-b border-[#e2ece6]/5 pb-0.5`}>
                              {log}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>

      </section>

      {/* Accordion Setup Guide & Microcontroller Wire sketch */}
      <footer className="max-w-7xl w-full mx-auto bg-[#0d110f]/30 border-2 border-[#e2ece6]/30 rounded-none overflow-hidden mt-2 mb-8 text-[#e2ece6]">
        <button
          onClick={() => setIsGuideOpen(!isGuideOpen)}
          className="w-full flex items-center justify-between px-4 py-3 bg-transparent border-b-2 border-[#e2ece6]/30 text-left outline-none cursor-pointer text-[#e2ece6]"
        >
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4" />
            <span className="text-xs uppercase tracking-wider font-mono">Microcontroller Hardware Integration Guide</span>
          </div>
          {isGuideOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        <AnimatePresence initial={false}>
          {isGuideOpen && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-5 bg-transparent">
                
                {/* Visual Connection Pinouts */}
                <div className="space-y-4">
                  <h3 className="text-xs font-mono uppercase tracking-wider flex items-center gap-1.5">
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    How to Setup your Device
                  </h3>
                  
                  <div className="space-y-3">
                    <div className="p-3 bg-transparent border border-[#e2ece6]/30 rounded-none flex items-start gap-3">
                      <div className="border border-[#e2ece6]/30 rounded-none p-1.5 font-mono text-xs">1</div>
                      <div className="text-xs leading-relaxed opacity-95 font-mono">
                        <span>Wiring sensors:</span> Hook up throttle pedal potentiometers or diagnostic OBD-II CAN bus decoders directly to your microcontroller.
                      </div>
                    </div>
                    <div className="p-3 bg-transparent border border-[#e2ece6]/30 rounded-none flex items-start gap-3">
                      <div className="border border-[#e2ece6]/30 rounded-none p-1.5 font-mono text-xs">2</div>
                      <div className="text-xs leading-relaxed opacity-95 font-mono">
                        <span>Formatting stream values:</span> Copy the Arduino C++ sketch shown on the right, compile, and upload it via the IDE. Your sketch must write telemetry values to the serial bus at <span>115200 baud</span>.
                      </div>
                    </div>
                    <div className="p-3 bg-transparent border border-[#e2ece6]/30 rounded-none flex items-start gap-3">
                      <div className="border border-[#e2ece6]/30 rounded-none p-1.5 font-mono text-xs">3</div>
                      <div className="text-xs leading-relaxed opacity-95 font-mono">
                        <span>Initiate telemetry:</span> Unplug the controller, connect it via USB, and hit <span>"CONNECT USB"</span> at the top. The browser will open a device selector. Choose your microcontroller (e.g. "Arduino Uno", "Teensy", "CH340 USB") to establish telemetry stream visualization!
                      </div>
                    </div>
                  </div>

                  {/* Schema layout */}
                  <div className="p-4 bg-transparent border border-[#e2ece6]/30 rounded-none">
                    <span className="text-[10px] font-mono block mb-2 uppercase opacity-80">DATA PROTOCOL SCHEMATIC</span>
                    <div className="font-mono text-center text-xs space-y-1">
                      <div className="bg-transparent py-1.5 rounded-none border border-[#e2ece6]/30">
                        CSV Frame: RPM,Speed,Temp,Throttle\n
                      </div>
                      <div className="opacity-75 text-[10px] pt-1">
                        Example packet string: <code className="bg-[#e2ece6] text-[#0d110f] px-1.5 py-0.5 rounded-none">"6250,114.5,96.2,85"</code>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right: Arduino copy sketch */}
                <ArduinoGuide />

              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="px-4 py-3 bg-transparent border-t-2 border-[#e2ece6]/30 text-center">
          <p className="text-[10px] font-mono opacity-80 text-[#e2ece6]">
            Designed for professional race telemetry & diagnostics engineering. Powered by native Web Serial API. No server-side middleware required.
          </p>
        </div>
      </footer>
      </div>
    </main>
  </div>
  );
}
