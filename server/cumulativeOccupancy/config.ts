export const OR_CAPACITY = {
  rooms: ['OR-1', 'OR-2', 'OR-3', 'OR-4', 'OR-5', 'OR-6', 'OR-7'] as const,
  minutesPerRoomPerDay: 1440, // 24 hours per room (configurable for future staffed shifts)
};

export const CUMULATIVE_CONFIG = {
  timezone: 'Africa/Cairo',
};
