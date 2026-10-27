import { useState, useEffect, useCallback, useRef } from 'react';

export interface DailyBedCensusItem {
  date: string;
  inpatientOccupied: number;
  inpatientCapacity: number;
  totalOccupied: number;
  totalCapacity: number;
  source: 'rollover' | 'backfill' | 'manual' | 'provisional';
}

export interface CumulativeBedData {
  month: string;
  daysInMonth: number;
  daysRecorded: number;
  missingDays: string[];
  includesProvisional: boolean;
  isFinalized: boolean;
  finalizedAt: string | null;
  inpatient: {
    patientDays: number;
    bedDays: number;
    rate: number;
  };
  total: {
    patientDays: number;
    bedDays: number;
    rate: number;
  };
  days: DailyBedCensusItem[];
}

export interface DailyORCensusItem {
  date: string;
  roomsAvailable: number;
  minutesPerRoom: number;
  bookedMinutes: number;
  roomsUsed: number;
  casesTotal: number;
  dcCount: number;
  hcCount: number;
  inCount: number;
  outCount: number;
  sicuCount: number;
  excludedCases: number;
  roomBreakdown: Record<string, { minutes: number; cases: number }>;
  source: 'rollover' | 'backfill' | 'manual' | 'provisional';
}

export interface CumulativeORData {
  month: string;
  daysInMonth: number;
  daysRecorded: number;
  includesProvisional: boolean;
  isFinalized: boolean;
  finalizedAt: string | null;
  bookedMinutes: number;
  availableMinutes: number;
  timeUtilization: number;
  roomDaysUsed: number;
  roomDaysAvailable: number;
  roomUtilization: number;
  casesTotal: number;
  dcCount: number;
  hcCount: number;
  inCount: number;
  outCount: number;
  sicuCount: number;
  roomBreakdown: Record<string, { minutes: number; cases: number }>;
  days: DailyORCensusItem[];
}

export function useCumulativeBeds(month?: string, refreshTrigger?: any) {
  const [data, setData] = useState<CumulativeBedData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef<boolean>(false);

  const fetchBeds = useCallback(async () => {
    try {
      if (!hasLoadedRef.current) {
        setLoading(true);
      }
      setError(null);
      const url = month ? `/api/occupancy/cumulative?month=${month}` : '/api/occupancy/cumulative';
      const res = await fetch(url);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      hasLoadedRef.current = true;
    } catch (err: any) {
      setError(err?.message || 'Failed to load cumulative bed occupancy');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    fetchBeds();
  }, [fetchBeds, refreshTrigger]);

  return { data, loading, error, refresh: fetchBeds };
}

export function useCumulativeOR(month?: string, refreshTrigger?: any) {
  const [data, setData] = useState<CumulativeORData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef<boolean>(false);

  const fetchOR = useCallback(async () => {
    try {
      if (!hasLoadedRef.current) {
        setLoading(true);
      }
      setError(null);
      const url = month ? `/api/or/cumulative?month=${month}` : '/api/or/cumulative';
      const res = await fetch(url);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      hasLoadedRef.current = true;
    } catch (err: any) {
      setError(err?.message || 'Failed to load cumulative OR utilization');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    fetchOR();
  }, [fetchOR, refreshTrigger]);

  return { data, loading, error, refresh: fetchOR };
}

export function useCumulativeBedHistory() {
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/occupancy/cumulative/history?limit=12');
      if (res.ok) {
        const json = await res.json();
        setHistory(json.summaries || []);
      }
    } catch (err) {
      console.warn('Failed to fetch bed history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, loading, refresh: fetchHistory };
}

export function useCumulativeORHistory() {
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/or/cumulative/history?limit=12');
      if (res.ok) {
        const json = await res.json();
        setHistory(json.summaries || []);
      }
    } catch (err) {
      console.warn('Failed to fetch OR history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, loading, refresh: fetchHistory };
}
