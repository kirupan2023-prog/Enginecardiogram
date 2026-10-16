import { useState } from 'react';
import { Copy, Check, Terminal, Cpu } from 'lucide-react';

export default function ArduinoGuide() {
  const [copied, setCopied] = useState(false);

  const arduinoCode = `/**
 * Automotive Telemetry Transmitter (Standard 115200 Baud)
 * Expected Format: RPM,Speed,Temp,Throttle,Load\\n
 * 
 * Upload this sketch to your Arduino, ESP32, Teensy, or Pico
 * to instantly visualize data on the telemetry dashboard.
 */

const int THROTTLE_PIN = A0; // Accelerometer or Potentiometer input
float simulatedRpm = 800.0;
float simulatedSpeed = 0.0;
float simulatedTemp = 40.0; // Start cool, warms up
float simulatedLoad = 20.0;
bool upshifting = true;

void setup() {
  // Start serial communication at 115200 baud (matched with dashboard)
  Serial.begin(115200);
  pinMode(THROTTLE_PIN, INPUT);
}

void loop() {
  // 1. Read Accelerometer / Throttle sensor input
  // Map analog 10-bit input (0-1023) to percentage (0-100)
  int throttleRaw = analogRead(THROTTLE_PIN);
  float throttlePercent = (throttleRaw / 1023.0) * 100.0;
  
  // If no hardware potentiometer connected, use simulation values:
  if (throttleRaw < 5) {
    throttlePercent = 75.0; // Default simulated throttle input
  }

  // 2. Compute dynamic, realistic powertrain telemetry
  if (upshifting) {
    simulatedRpm += (throttlePercent * 1.8) + random(-20, 30);
    simulatedSpeed += (simulatedRpm / 15000.0);
    simulatedLoad = constrain((throttlePercent * 0.7) + (simulatedRpm / 100.0), 0, 100);
    
    if (simulatedRpm > 3200.0) {
      simulatedRpm = 1400.0; 
      simulatedTemp += 1.5; // Engine heats up during high-rev shifts
    }
  }

  // Keep temperature bounded realistically
  simulatedTemp += (simulatedRpm / 200000.0) - 0.02;
  if (simulatedTemp < 85.0) simulatedTemp += 0.1;
  if (simulatedTemp > 105.0) simulatedTemp -= 0.05;

  // 3. Format telemetry string strictly as CSV: RPM,Speed,Temp,Throttle,Load
  // Followed by a newline character (Serial.println provides this)
  Serial.print(simulatedRpm, 0);        // values[0]: Engine Speed (RPM)
  Serial.print(",");
  Serial.print(simulatedSpeed, 1);      // values[1]: Vehicle Speed (KM/H)
  Serial.print(",");
  Serial.print(simulatedTemp, 1);       // values[2]: Coolant Temp (°C)
  Serial.print(",");
  Serial.print(throttlePercent, 0);     // values[3]: Throttle Pos (%)
  Serial.print(",");
  Serial.println(simulatedLoad, 0);     // values[4]: Engine Load (%)

  // Broadcast data at ~10Hz (100ms interval) for ultra-responsive dashboard charts
  delay(100);
}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(arduinoCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <div className="bg-[#0d110f]/30 border-2 border-[#e2ece6]/30 rounded-none overflow-hidden text-[#e2ece6] w-full max-w-full">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2.5 sm:py-3 bg-transparent border-b-2 border-[#e2ece6]/30">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4" />
          <span className="text-xs font-mono uppercase tracking-widest">MICROCONTROLLER SOURCE (ARDUINO / C++)</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono border-2 border-[#e2ece6]/30 bg-[#0d110f] text-[#e2ece6] hover:bg-[#e2ece6] hover:text-[#0d110f] transition-all rounded-none cursor-pointer"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5" />
              <span>COPIED</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>COPY CODE</span>
            </>
          )}
        </button>
      </div>

      <div className="p-4">
        <p className="text-xs mb-3 leading-relaxed opacity-95 font-mono">
          Ensure your controller broadcasts at <code className="bg-[#e2ece6] text-[#0d110f] px-1.5 py-0.5 font-mono">115200 Baud</code> and outputs exactly 4 comma-separated values ending in a newline: <code className="bg-[#e2ece6] text-[#0d110f] px-1.5 py-0.5 font-mono">RPM,Speed,Temp,Throttle\n</code>.
        </p>
        <div className="relative">
          <pre className="text-xs font-mono leading-relaxed text-[#e2ece6] bg-[#0d110f]/40 p-3.5 rounded-none overflow-x-auto max-h-[340px] border border-[#e2ece6]/30">
            <code>{arduinoCode}</code>
          </pre>
          <div className="absolute right-3 bottom-3 opacity-30 flex items-center gap-1 pointer-events-none">
            <Terminal className="w-5 h-5" />
          </div>
        </div>
      </div>
    </div>
  );
}
