export interface TruckProfile {
  id: 'class8' | 'medium' | 'light';
  name: string;
  model: string;
  redlineRpm: number;
  rpmWarning: number;
  maxSpeedKmh: number;
  maxSpeedMph: number;
  chartMaxRpm: number;
  maxGears: number;
  accelFactor: number; // physics coefficient for RPM climb
  shiftDropRpm: number; // RPM drop during gear change
  gearRatios: number[]; // gear speed multipliers
  description: string;
}

export const TRUCK_PROFILES: Record<string, TruckProfile> = {
  class8: {
    id: 'class8',
    name: 'Class 8 Heavy Hauler',
    model: 'Peterbilt 579',
    redlineRpm: 2200,
    rpmWarning: 1950,
    maxSpeedKmh: 120,
    maxSpeedMph: 75,
    chartMaxRpm: 2600,
    maxGears: 10,
    accelFactor: 0.45, // Sluggish, heavy torque climb
    shiftDropRpm: 800,  // Drops lots of RPMs when shifting
    gearRatios: [0, 0.0035, 0.006, 0.009, 0.013, 0.018, 0.023, 0.028, 0.033, 0.038, 0.043],
    description: 'Heavy duty commercial semi-truck. Sluggish acceleration under heavy load, 10-speed gear range, low 2,200 RPM diesel redline.'
  },
  medium: {
    id: 'medium',
    name: 'Medium Duty Delivery',
    model: 'Isuzu NPR',
    redlineRpm: 3500,
    rpmWarning: 3100,
    maxSpeedKmh: 140,
    maxSpeedMph: 87,
    chartMaxRpm: 4000,
    maxGears: 6,
    accelFactor: 0.8, // Moderate acceleration
    shiftDropRpm: 1200, // Normal shifting pattern
    gearRatios: [0, 0.007, 0.012, 0.018, 0.026, 0.034, 0.042],
    description: 'Urban delivery truck. Moderate acceleration, 6-speed transmission, 3,500 RPM diesel redline.'
  },
  light: {
    id: 'light',
    name: 'Light Duty Pickup',
    model: 'Ford F-150',
    redlineRpm: 6000,
    rpmWarning: 5300,
    maxSpeedKmh: 180,
    maxSpeedMph: 112,
    chartMaxRpm: 7000,
    maxGears: 10,
    accelFactor: 1.6, // Peppy, fast acceleration
    shiftDropRpm: 1600, // Quick high-rev drop
    gearRatios: [0, 0.004, 0.007, 0.011, 0.016, 0.021, 0.026, 0.031, 0.036, 0.041, 0.046],
    description: 'Fleet service pickup truck. Peppy acceleration, 10-speed automatic transmission, 6,000 RPM redline.'
  }
};
