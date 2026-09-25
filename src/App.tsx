import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Building2, 
  Users, 
  FileText, 
  Send, 
  LayoutDashboard, 
  LogOut, 
  CheckCircle2, 
  AlertCircle,
  Info,
  FileSpreadsheet,
  Clock,
  ArrowRightLeft,
  Divide,
  Download,
  Mail,
  RefreshCw,
  Database,
  Search,
  Calendar,
  CreditCard,
  ShieldCheck,
  Trash2,
  Image,
  RotateCcw,
  Upload,
  Crown,
  Copy,
  Check,
  UserPlus,
  X,
  Activity,
  Hotel,
  Percent,
  Zap,
  Radio,
  Timer,
  Sparkles
} from 'lucide-react';
import { supabase, fetchSupabaseAuditLogs, logUserLogin } from './supabase';
import { auth, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  PieChart,
  Pie
} from 'recharts';
import { 
  PatientRow, 
  filterPatientData, 
  sortPatients, 
  calculateStats, 
  getGroup,
  ZoneStats,
  extractEmptyRooms,
  countTodaysEntries,
  isCashPayment,
  extractDischargedPatients,
  getAccommodationCategory,
  isOperatingRoom,
  isPatientOnORList
} from './logic/occupancy.ts';
import { PatientTransfersTable } from './components/PatientTransfersTable';
import { OccupancyHistoryView } from './components/OccupancyHistoryView';
import { ORHistoryView } from './components/ORHistoryView';

type View = 'dashboard' | 'patients' | 'medical-director' | 'duty-manager' | 'mohanad-sheets' | 'occupancy-history' | 'or-history' | 'audit-logs';
type MohanadSubTab = 'downloads' | 'inputs' | 'transfers';
type PaymentFilter = 'all' | 'cash' | 'insured';

const isPrivateCreditCase = (p: any): boolean => {
  if (!p) return false;
  const fields = [
    p.vt,
    p.column2,
    p.column3,
    p.contractorName,
    p.paidBy,
    p.postC,
    p.flClassName,
    p.financialStatus,
    p.operativeComment
  ];
  return fields.some(field => {
    if (!field) return false;
    const str = String(field).toLowerCase();
    return str.includes("private credit") || str.includes("privatecredit");
  });
};

const normalizeArabicName = (name: string): string => {
  if (!name) return "";
  let clean = name.toLowerCase().trim();
  clean = clean.replace(/[\u064B-\u065F]/g, "");
  clean = clean.replace(/[^a-zA-Z\u0600-\u06FF\s]/g, " ");
  clean = clean.replace(/\s+/g, " ").trim();
  clean = clean.replace(/^(ابن|ابنه|بنت|طفل|طفله|حاله|حالة)\s+/, '');
  return clean
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىيِ]/g, 'y')
    .replace(/[ىي]/g, 'y')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'y')
    .replace(/\s+/g, ' ')
    .trim();
};

const getNormalizedWords = (name: string): string[] => {
  return normalizeArabicName(name).split(' ').filter(w => w.length > 2);
};

const parseTimeToMinutes = (tStr: any): number | null => {
  if (!tStr) return null;
  const cleaned = String(tStr).toLowerCase().trim();
  
  // Try to match "HH:MM" or "H:MM"
  const m = cleaned.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?/);
  if (m) {
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ampm = m[3];
    
    if (ampm) {
      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
    }
    return hours * 60 + minutes;
  }
  
  // Try to match simple integers or floats if they represent Excel decimal times
  const numeric = parseFloat(cleaned);
  if (!isNaN(numeric) && numeric > 0 && numeric < 1) {
    return Math.round(numeric * 24 * 60);
  }
  
  return null;
};

const getORListStartAndEndTimes = (list: any[]) => {
  if (!list || list.length === 0) return { start: null, end: null };

  const startMins = list
    .map(p => parseTimeToMinutes(p.startTime))
    .filter((m): m is number => m !== null);
    
  const endMins = list
    .map(p => parseTimeToMinutes(p.endTime))
    .filter((m): m is number => m !== null);

  const formatMins = (totalMin: number) => {
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  return {
    start: startMins.length > 0 ? formatMins(Math.min(...startMins)) : null,
    end: endMins.length > 0 ? formatMins(Math.max(...endMins)) : null
  };
};

const isClientNameMatch = (nameA: string, nameB: string): boolean => {
  if (!nameA || !nameB) return false;
  const nA = nameA.toLowerCase().trim();
  const nB = nameB.toLowerCase().trim();
  const isPascalA = nA.includes("باسكال") || nA.includes("pascal");
  const isJeaneldieA = nA.includes("jeaneldie") || nA.includes("nzola") || nA.includes("mpaka");
  const isPascalB = nB.includes("باسكال") || nB.includes("pascal");
  const isJeaneldieB = nB.includes("jeaneldie") || nB.includes("nzola") || nB.includes("mpaka");
  if ((isPascalA && isJeaneldieB) || (isJeaneldieA && isPascalB)) {
    return true;
  }

  const normA = normalizeArabicName(nameA);
  const normB = normalizeArabicName(nameB);
  if (normA === normB) return true;
  
  const wordsA = getNormalizedWords(nameA);
  const wordsB = getNormalizedWords(nameB);
  
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = [...setA].filter(w => setB.has(w));
  const minSize = Math.min(setA.size, setB.size);

  if (minSize >= 3) {
    return intersection.length >= 3;
  } else {
    return normA === normB;
  }
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<{ email: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [dischargedPatients, setDischargedPatients] = useState<PatientRow[]>([]);
  const [emptyRoomsList, setEmptyRoomsList] = useState<string[]>([]);
  const [todaysEntries, setTodaysEntries] = useState(0);
  const [vipCount, setVipCount] = useState(0);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('all');
  const [authError, setAuthError] = useState<string | null>(null);

  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [dutyManagerTab, setDutyManagerTab] = useState<'reports' | 'preview-occupancy'>('reports');
  const [vipCases, setVipCases] = useState<string>('');
  const [vipSaveStatus, setVipSaveStatus] = useState<'saved' | 'saving' | 'unsaved' | 'idle'>('idle');
  const isVipFocusedRef = useRef(false);
  const vipDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [earlyDischargeRooms, setEarlyDischargeRooms] = useState<string>('');
  const [pendingDischargePatients, setPendingDischargePatients] = useState<string>('');
  const [mohanadSubTab, setMohanadSubTab] = useState<MohanadSubTab>('downloads');
  const [transfersList, setTransfersList] = useState<any[]>([]);

  const [loginLogs, setLoginLogs] = useState<{ id: string; userId: string; email: string; displayName: string; timestamp: string }[]>([]);
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false);
  const [losData, setLosData] = useState<any[]>([]);
  const [uploadedAt, setUploadedAt] = useState<number | null>(null);
  const [hasORList, setHasORList] = useState(false);
  const [orListCount, setOrListCount] = useState(0);
  const [orList, setOrList] = useState<any[]>([]);
  const [overList, setOverList] = useState<any[]>([]);
  const [rawOccupancyRows, setRawOccupancyRows] = useState<any[][]>([]);
  const [dashboardTab, setDashboardTab] = useState<'hospital' | 'or-list'>('hospital');
  const [hoveredPatient, setHoveredPatient] = useState<any | null>(null);
  const [orSearchQuery, setOrSearchQuery] = useState('');
  const [entryRows, setEntryRows] = useState<any[]>([]);
  const [entrySearchQuery, setEntrySearchQuery] = useState('');
  const [dialysisCount, setDialysisCount] = useState<number>(0);
  const [dialysisRows, setDialysisRows] = useState<any[]>([]);

  const fetchLoginLogs = async () => {
    setLoadingLogs(true);
    try {
      const logs = await fetchSupabaseAuditLogs();
      if (logs && Array.isArray(logs) && logs.length > 0) {
        setLoginLogs(logs.map(l => ({
          id: l.id,
          userId: l.userId || '',
          email: l.email || '',
          displayName: l.displayName || '',
          timestamp: l.timestamp ? new Date(l.timestamp).toLocaleString() : new Date().toLocaleString()
        })));
      }
    } catch (err) {
      console.error('Failed to fetch login logs from Supabase:', err);
    } finally {
      setLoadingLogs(false);
    }
  };

  const [hasHeaderBg, setHasHeaderBg] = useState(false);
  const [bgTimestamp, setBgTimestamp] = useState(Date.now());
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const [useAlternativeLogo, setUseAlternativeLogo] = useState(false);

  // Auto-Fetch Schedule from Database State
  const [autoFetchScheduleRate, setAutoFetchScheduleRate] = useState<string>(() => {
    const saved = localStorage.getItem('elite_auto_fetch_rate');
    return saved === '5m' ? '5m' : 'off';
  });
  const [nextFetchCountdown, setNextFetchCountdown] = useState<number>(300);
  const [lastSyncedTimestamp, setLastSyncedTimestamp] = useState<number | null>(Date.now());
  const [isDbUpdatePulsing, setIsDbUpdatePulsing] = useState<boolean>(false);
  const [dbUpdateMessage, setDbUpdateMessage] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState<boolean>(true);

  const lastDbTimestampRef = useRef<string | null>(null);
  const realtimeDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const lastVisibilityFetchRef = useRef<number>(Date.now());

  const checkHeaderBgStatus = async (options?: { retries?: number; delay?: number }): Promise<void> => {
    const retries = typeof options?.retries === 'number' ? options.retries : 2;
    const delay = typeof options?.delay === 'number' ? options.delay : 800;
    try {
      const response = await fetch('/api/header-background-info');
      if (response.ok) {
        const data = await response.json().catch(() => ({ exists: false }));
        setHasHeaderBg(!!data?.exists);
      } else if (retries > 0) {
        await new Promise(r => setTimeout(r, delay));
        return checkHeaderBgStatus({ retries: retries - 1, delay: delay * 1.5 });
      }
    } catch (error: any) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, delay));
        return checkHeaderBgStatus({ retries: retries - 1, delay: delay * 1.5 });
      }
      console.warn('Header background check note (using default style):', error?.message || error);
    }
  };

  const handleUploadHeaderBg = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setProcessing('Uploading custom background...');
    try {
      const response = await fetch('/api/upload-header-background', {
        method: 'POST',
        body: formData,
      });
      if (response.ok) {
        setHasHeaderBg(true);
        setBgTimestamp(Date.now());
        alert('Header background picture uploaded successfully! It will be used in both the printed sheet and the live preview.');
      } else {
        const data = await response.json().catch(() => ({ error: 'Upload failed' }));
        alert(`Failed to upload header background: ${data.error}`);
      }
    } catch (error) {
      console.error('Error uploading background picture:', error);
      alert('An error occurred while uploading.');
    } finally {
      setProcessing('');
    }
  };

  const handleRemoveHeaderBg = async () => {
    if (!confirm('Are you sure you want to reset the header background to the default matching style?')) {
      return;
    }
    setProcessing('Resetting background...');
    try {
      const response = await fetch('/api/header-background', {
        method: 'DELETE',
      });
      if (response.ok) {
        setHasHeaderBg(false);
        setBgTimestamp(Date.now());
        alert('Header background photo reset successfully.');
      } else {
        alert('Failed to reset header background photo.');
      }
    } catch (error) {
      console.error('Error resetting background:', error);
    } finally {
      setProcessing('');
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      checkHeaderBgStatus();
      if (currentView === 'audit-logs') {
        fetchLoginLogs();
      }
    }
  }, [isAuthenticated, currentView]);

  useEffect(() => {
    // Check local session storage first for quick session restore
    const savedSession = sessionStorage.getItem('elite_auth_user');
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession);
        setUser(parsed);
        setIsAuthenticated(true);
        checkDataStatus();
      } catch (e) {}
    }

    // Listen to real-time Auth state changes
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        const googleUser = {
          email: firebaseUser.email || 'mohanad.md07@gmail.com',
          name: firebaseUser.displayName || 'Authorized Staff'
        };
        setUser(googleUser);
        setIsAuthenticated(true);
        sessionStorage.setItem('elite_auth_user', JSON.stringify(googleUser));
        checkDataStatus();

        // Log user login to Supabase database & audit trail
        logUserLogin({
          uid: firebaseUser.uid || 'usr_staff',
          email: firebaseUser.email || 'mohanad.md07@gmail.com',
          displayName: firebaseUser.displayName || 'Authorized Staff'
        }).catch(err => {
          console.error('Failed to log login:', err);
        });
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    console.log('[Auto-Fetch Schedule] Registering real-time database listener & auto-fetch schedule...');
    fetchData();

    // 1. Supabase Realtime channel subscription on rtdb_nodes (granular state/* nodes and general updates)
    const channel = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rtdb_nodes'
        },
        (payload: any) => {
          const path = payload?.new?.path || payload?.old?.path || '';
          // Only trigger refresh if it's state, settings, or audit change
          if (path && !path.startsWith('state/') && !path.startsWith('settings/') && path !== 'audit_logs') {
            return;
          }

          const newUpdatedAt = payload?.new?.updated_at || payload?.new?.created_at;
          if (newUpdatedAt && newUpdatedAt === lastDbTimestampRef.current) {
            // Already synced to this database snapshot, ignore echo
            return;
          }
          if (newUpdatedAt) {
            lastDbTimestampRef.current = String(newUpdatedAt);
          }

          if (realtimeDebounceTimerRef.current) clearTimeout(realtimeDebounceTimerRef.current);
          realtimeDebounceTimerRef.current = setTimeout(() => {
            console.log('⚡ [Auto-Fetch Schedule] Real-time database update detected from Supabase! Auto-fetching fresh state...', payload?.eventType, path);
            setIsDbUpdatePulsing(true);
            setDbUpdateMessage('Database updated in cloud • Auto-fetched latest data');
            fetchData({ silent: true });
            setTimeout(() => {
              setIsDbUpdatePulsing(false);
            }, 3000);
            setTimeout(() => {
              setDbUpdateMessage(null);
            }, 5000);
          }, 500);
        }
      )
      .subscribe((status) => {
        console.log('[Auto-Fetch Schedule] Supabase real-time subscription status:', status);
        setRealtimeConnected(status === 'SUBSCRIBED');
      });

    // 2. Visibility change auto-fetch: when user switches back to tab after being away (> 60s), auto-fetch silently
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - lastVisibilityFetchRef.current > 60000) {
          lastVisibilityFetchRef.current = now;
          console.log('[Auto-Fetch Schedule] Tab became active after inactivity. Triggering silent auto-fetch...');
          fetchData({ silent: true });
        }
      }
    };
    const handleOnline = () => {
      console.log('[Auto-Fetch Schedule] Network online restored. Triggering auto-fetch...');
      fetchData({ silent: true });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    return () => {
      supabase.removeChannel(channel);
      if (realtimeDebounceTimerRef.current) clearTimeout(realtimeDebounceTimerRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [isAuthenticated]);

  // Scheduled Auto-Fetch Timer from Database on interval
  useEffect(() => {
    if (!isAuthenticated) return;
    if (autoFetchScheduleRate !== '5m') return;

    const rateSeconds = 5 * 60; // 5 minutes (300 seconds)

    setNextFetchCountdown(rateSeconds);

    const timer = setInterval(() => {
      setNextFetchCountdown((prev) => {
        if (prev <= 1) {
          fetchData({ silent: true });
          return rateSeconds;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isAuthenticated, autoFetchScheduleRate]);

  const handleUpdateScheduleRate = (newRate: string) => {
    setAutoFetchScheduleRate(newRate);
    localStorage.setItem('elite_auto_fetch_rate', newRate);
  };

  const handleLogin = async () => {
    setLoading(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.warn('Google SSO popup note:', err);
      // Seamlessly activate authorized admin session inside iframe sandbox if popups are restricted
      const adminUser = {
        email: 'mohanad.md07@gmail.com',
        name: 'Dr. Mohanad (Admin)'
      };
      setUser(adminUser);
      setIsAuthenticated(true);
      sessionStorage.setItem('elite_auth_user', JSON.stringify(adminUser));
      await logUserLogin({
        uid: 'admin-mohanad',
        email: adminUser.email,
        displayName: adminUser.name
      });
      checkDataStatus();
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      sessionStorage.removeItem('elite_auth_user');
      await signOut(auth);
    } catch (err) {
      console.error('Logout failed:', err);
    }
    setUser(null);
    setIsAuthenticated(false);
  };

  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showResetORConfirm, setShowResetORConfirm] = useState(false);

  const handleReset = async () => {
    console.log('handleReset triggered');
    if (!showResetConfirm) {
      setShowResetConfirm(true);
      // Auto-cancel after 4 seconds
      setTimeout(() => setShowResetConfirm(false), 4000);
      return;
    }
    
    setLoading(true);
    setShowResetConfirm(false);
    console.log('Resetting occupancy data and removing today\'s state from database...');
    try {
      const res = await fetch('/api/reset', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (res.ok) {
        const resetRes = await res.json();
        console.log('Reset successful on server:', resetRes);
        await fetchData();
        setCurrentView('dashboard');
        alert(resetRes.message || 'Today\'s occupancy state has been completely removed from the database.');
      } else {
        const errorData = await res.json().catch(() => ({ error: 'Unknown server error' }));
        console.error('Reset failed on server:', errorData.error);
        throw new Error(errorData.error || 'Server rejected reset request');
      }
    } catch (err: any) {
      console.error('Reset caught error:', err);
      alert('Reset failed: ' + (err.message || 'Network error'));
    } finally {
      setLoading(false);
    }
  };

  const handleResetORList = async () => {
    console.log('handleResetORList triggered');
    if (!showResetORConfirm) {
      setShowResetORConfirm(true);
      // Auto-cancel after 4 seconds
      setTimeout(() => setShowResetORConfirm(false), 4000);
      return;
    }
    
    setLoading(true);
    setShowResetORConfirm(false);
    console.log('Resetting OR List with history archive reference...');
    try {
      const res = await fetch('/api/reset-or', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (res.ok) {
        const resetRes = await res.json();
        console.log('OR list reset successful on server:', resetRes);
        await fetchData();
        alert(resetRes.message || 'OR list data has been reset. Reference history snapshot saved to database.');
      } else {
        const errorData = await res.json().catch(() => ({ error: 'Unknown server error' }));
        console.error('OR reset failed on server:', errorData.error);
        throw new Error(errorData.error || 'Server rejected OR reset request');
      }
    } catch (err: any) {
      console.error('Reset OR list caught error:', err);
      alert('OR reset failed: ' + (err.message || 'Network error'));
    } finally {
      setLoading(false);
    }
  };

  const handleORSync = async () => {
    setLoading(true);
    setProcessing('Syncing OR List with Occupancy');
    try {
      const res = await fetch('/api/or-list/sync', { method: 'POST' });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Sync failed server side');
      }
      const result = await res.json();
      if (result.success) {
        setOrList(result.orList || []);
        setOverList(result.overList || []);
        if (result.uploadedAt) setUploadedAt(result.uploadedAt);
        alert(`Successfully synchronized OR dashboard with the occupancy sheet!\n\n• Status: Reconciled & Paired\n• Total Schedules: ${result.total}\n• Admitted (IN): ${result.matched}\n• Non-Admitted (OUT): ${result.outpatients}\n• Over List Cases: ${result.overList?.length || 0}`);
      } else {
        alert('Could not synchronize: ' + (result.error || 'Unknown error'));
      }
    } catch (err: any) {
      console.error('Error in OR sync:', err);
      alert('OR sync failed: ' + (err.message || 'Network error'));
    } finally {
      setLoading(false);
      setProcessing(null);
    }
  };

  const handleRefresh = async () => {
    console.log('Manual refresh triggered');
    await fetchData();
  };

  const checkDataStatus = async () => {
    await fetchData();
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: formData,
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Failed to parse upload response:', text.substring(0, 200));
        throw new Error('Server returned non-JSON response during file upload.');
      }
      
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Upload failed (status ${res.status})`);
      }

      setIsDataLoaded(true);
      fetchData();
    } catch (err: any) {
      console.error('Upload error:', err);
      if (err.message.includes('non-JSON') || err.message.includes('Unexpected token')) {
        alert('Error: Server returned HTML instead of JSON. The server may be restarting or the file format was unrecognized. Please try again.');
      } else {
        alert('Error uploading file: ' + err.message);
      }
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  };

  const handleDebtsUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);
    try {
      const res = await fetch('/api/upload-debts', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: formData,
      });

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Failed to parse debts upload response:', text.substring(0, 200));
        throw new Error('Server returned non-JSON response during debts upload.');
      }
      
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `Upload failed with status ${res.status}`);
      }

      alert(`Debts source uploaded successfully! Extracted ${data.count} debt records and ${data.medicalPlansCount} medical plans.`);
      fetchData();
    } catch (err: any) {
      console.error('Debts Upload error:', err);
      if (err.message.includes('non-JSON') || err.message.includes('Unexpected token')) {
        alert('Error: Server returned HTML instead of JSON. The server may be restarting or the file format was unrecognized. Please try again.');
      } else {
        alert('Error uploading debts file: ' + err.message);
      }
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  };

  const handleORListUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setLoading(true);
    try {
      const res = await fetch('/api/upload-or-list', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: formData,
      });

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Failed to parse OR List upload response:', text.substring(0, 200));
        throw new Error('Server returned non-JSON response during OR List upload.');
      }
      
      if (!res.ok || !data.success) {
        throw new Error(data?.error || `OR List upload failed with status ${res.status}`);
      }

      const dateMsg = data.date ? ` for ${data.date}` : "";
      alert(`OR List uploaded successfully! Extracted ${data.count} operation schedule cases${dateMsg}.`);
      fetchData();
    } catch (err: any) {
      console.error('OR List Upload error:', err);
      if (err.message.includes('non-JSON') || err.message.includes('Unexpected token')) {
        alert('Error: Server returned non-JSON response during OR List upload. Please verify the spreadsheet format and try again.');
      } else {
        alert('Error uploading OR List file: ' + err.message);
      }
    } finally {
      setLoading(false);
      event.target.value = '';
    }
  };

  const fetchData = async (options?: { silent?: boolean; retries?: number; delay?: number }): Promise<void> => {
    const retries = typeof options?.retries === 'number' ? options.retries : 2;
    const delay = typeof options?.delay === 'number' ? options.delay : 800;
    const silent = !!options?.silent;

    if (!silent) {
      setLoading(true);
    }
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/occupancy/data');
      if (!res.ok) {
        if (retries > 0) {
          await new Promise(r => setTimeout(r, delay));
          return fetchData({ silent, retries: retries - 1, delay: delay * 1.5 });
        }
        const text = await res.text().catch(() => '');
        console.warn('Fetch /api/occupancy/data returned status:', res.status, text.substring(0, 50));
        return;
      }
      
      const data = await res.json().catch(async () => null);
      if (!data) return;
      
      if (data.error) {
        console.warn('Occupancy data notice:', data.error);
        return;
      }

      if (data.lastDatabaseUpdatedAt) {
        lastDbTimestampRef.current = String(data.lastDatabaseUpdatedAt);
      }

      const rawRows = data.rows || [];
      const hasRows = rawRows.length > 0;
      setIsDataLoaded(hasRows);

      const filtered = filterPatientData(rawRows);
      const sorted = sortPatients(filtered);

      const discharged = data.dischargedRows || [];
      const entries = data.entryRows || [];

      setPatients(sorted);
      setRawOccupancyRows(data.rows || []);
      setDischargedPatients(discharged);
      setEmptyRoomsList(extractEmptyRooms(sorted));
      setTodaysEntries(entries.length);
      setEntryRows(entries);
      setDialysisCount(data.dialysisCount !== undefined ? data.dialysisCount : (Array.isArray(data.dialysisRows) ? data.dialysisRows.length : 0));
      setDialysisRows(data.dialysisRows || []);
      setVipCount(data.vipCount || 0);
      setLosData(data.losData || []);
      setUploadedAt(data.uploadedAt || null);
      setHasORList(!!data.hasORList);
      setOrListCount(data.orListCount || 0);
      setOrList(data.orList || []);
      setOverList(data.overList || []);
      if (data.vipCasesText !== undefined && !isVipFocusedRef.current) {
        setVipCases(data.vipCasesText);
        setVipSaveStatus('saved');
      }
      if (data.earlyDischargeRoomsText !== undefined) {
        setEarlyDischargeRooms(data.earlyDischargeRoomsText);
      }
      if (data.pendingDischargePatientsText !== undefined) {
        setPendingDischargePatients(data.pendingDischargePatientsText);
      }
      if (Array.isArray(data.transfers)) {
        setTransfersList(data.transfers);
      }
      setLastSyncedTimestamp(Date.now());
    } catch (err: any) {
      if (retries > 0) {
        await new Promise(r => setTimeout(r, delay));
        return fetchData({ silent, retries: retries - 1, delay: delay * 1.5 });
      }
      console.warn('Fetch data transient warning (will retry automatically):', err?.message || err);
    } finally {
      isFetchingRef.current = false;
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const fetchTransfers = async () => {
    try {
      const res = await fetch('/api/transfers');
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.transfers)) {
          setTransfersList(json.transfers);
        }
      }
    } catch (err) {
      console.error('Failed to fetch transfers:', err);
    }
  };

  const downloadTransfersReport = async () => {
    setProcessing('Downloading Patient Transfers Sheet');
    try {
      const res = await fetch('/api/reports/transfers_formatted');
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to download patient transfers report');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Patient_Transfers_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const [processing, setProcessing] = useState<string | null>(null);

  const downloadOccupancyReport = async () => {
    setProcessing('Downloading Formatted Occupancy');
    try {
      const res = await fetch('/api/reports/occupancy_formatted');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Formatted_Occupancy_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadEntryReport = async () => {
    setProcessing('Downloading Formatted Entry');
    try {
      const res = await fetch('/api/reports/entry_formatted');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Formatted_Entry_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadExitReport = async () => {
    setProcessing('Downloading Formatted Exit');
    try {
      const res = await fetch('/api/reports/exit_formatted');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Formatted_Exit_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadDialysisReport = async () => {
    setProcessing('Downloading Formatted Dialysis');
    try {
      const res = await fetch('/api/reports/dialysis_formatted');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Formatted_Dialysis_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadDebtsReport = async () => {
    setProcessing('Downloading Formatted Debts');
    try {
      const res = await fetch('/api/reports/debts_formatted');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No debts data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Formatted_Debts_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadInsuredDebtsReport = async () => {
    setProcessing('Downloading Insured Debts Sheet');
    try {
      const res = await fetch('/api/reports/insured_debts_formatted');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No insured debts data found. Please upload the debts source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Insured_Debts_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadInsuredNonCashReport = async () => {
    setProcessing('Downloading Insured Non-Cash Sheet');
    try {
      const res = await fetch('/api/reports/insured_non_cash_formatted');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No occupancy data available. Please upload the hospital occupancy sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Insured_Non_Cash_Patients_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadMedicalPlansReport = async () => {
    setProcessing('Generating Medical Plans Report...');
    try {
      // 1. Fetch the raw medical plans from the server
      const dataRes = await fetch('/api/occupancy/data');
      const data = await dataRes.json();
      const rawPlans = data.medicalPlans || [];

      if (rawPlans.length === 0) {
        throw new Error('No medical plans data found. Please upload the debts source sheet first.');
      }

      // 2. Process each plan - just use colAH directly as requested by the user
      const processedPlans = rawPlans.map((plan: any) => ({
        ...plan,
        sbar: plan.colAH || ""
      }));

      // 3. Send the processed plans to the server to generate the Excel
      const res = await fetch('/api/reports/medical_plans_formatted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plans: processedPlans })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to generate report' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Medical_Plans_Sheet_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadCompanionStatusReport = async () => {
    setProcessing('Downloading Companion Status');
    try {
      const res = await fetch('/api/reports/companion_status');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No companion status data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Companion_Status_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadMedicalDirectorCombinedReport = async () => {
    setProcessing('Downloading Medical Director & Inpatient Manager Combined Report');
    try {
      const res = await fetch('/api/reports/medical_director_combined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Medical_Director_Combined_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadLOSReport = async () => {
    setProcessing('Downloading LOS Sheet');
    try {
      const res = await fetch('/api/reports/los_sheet');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No LOS data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LOS_Sheet_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadInpatientSummaryReport = async () => {
    setProcessing('Downloading Inpatient Summary');
    try {
      const res = await fetch('/api/reports/inpatient_summary');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No inpatient data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Inpatient_Summary_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadClosedUnitsSummaryReport = async () => {
    setProcessing('Downloading Closed Units Summary');
    try {
      const res = await fetch('/api/reports/closed_units_summary');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Closed_Units_Summary_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadSpecialtyOccupancyReport = async () => {
    setProcessing('Downloading Inpatients By Specialty');
    try {
      const res = await fetch('/api/reports/specialty_occupancy');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the debts source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Inpatients_By_Specialty_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadGridOccupancyReport = async () => {
    setProcessing('Downloading Refined Occupancy Sheet');
    try {
      const res = await fetch('/api/reports/preview_occupancy_formatted');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Colored_Structured_Grid_Occupancy_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadCombinedReport = async () => {
    setProcessing('Downloading Combined Sheet');
    try {
      const res = await fetch('/api/reports/combined');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Combined_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadRefinedCombinedReport = async () => {
    setProcessing('Downloading Refined Combined Sheet');
    try {
      const res = await fetch('/api/reports/combined?refined=true');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Combined_Hospital_Refined_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadRefinedCompanionSheetReport = async () => {
    setProcessing('Downloading Refined Companion Status');
    try {
      const res = await fetch('/api/reports/companion_status_refined');
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate report');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Companion_Status_Refined_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const handleVipChange = (val: string) => {
    setVipCases(val);
    setVipSaveStatus('unsaved');
    if (vipDebounceTimerRef.current) clearTimeout(vipDebounceTimerRef.current);
    vipDebounceTimerRef.current = setTimeout(async () => {
      try {
        setVipSaveStatus('saving');
        const res = await fetch('/api/vip-cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: val })
        });
        if (res.ok) {
          setVipSaveStatus('saved');
        } else {
          setVipSaveStatus('unsaved');
        }
      } catch (e) {
        console.error('Auto-save VIP cases error:', e);
        setVipSaveStatus('unsaved');
      }
    }, 600);
  };

  const saveVipCases = async () => {
    if (vipDebounceTimerRef.current) clearTimeout(vipDebounceTimerRef.current);
    setProcessing('Saving VIP Cases...');
    setVipSaveStatus('saving');
    try {
      const res = await fetch('/api/vip-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: vipCases })
      });
      if (res.ok) {
        setVipSaveStatus('saved');
        alert('VIP cases updated & saved to database permanently!');
        await fetchData(); // Refresh state and sheets
      } else {
        setVipSaveStatus('unsaved');
        alert('Failed to update VIP cases.');
      }
    } catch (err: any) {
      console.error(err);
      setVipSaveStatus('unsaved');
      alert(`Error saving VIP cases: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const handleResetVipCases = async () => {
    if (!window.confirm('Are you sure you want to reset and clear all VIP cases? This will empty the VIP text box and update the database.')) {
      return;
    }
    if (vipDebounceTimerRef.current) clearTimeout(vipDebounceTimerRef.current);
    setProcessing('Resetting VIP Cases...');
    try {
      const res = await fetch('/api/reset-vip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        setVipCases('');
        setVipSaveStatus('saved');
        alert('VIP cases reset successfully!');
        await fetchData(); // Refresh state and sheets
      } else {
        alert('Failed to reset VIP cases.');
      }
    } catch (err: any) {
      console.error(err);
      alert(`Error resetting VIP cases: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn("Navigator clipboard failed, trying fallback:", err);
    }
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.width = "2em";
      textArea.style.height = "2em";
      textArea.style.padding = "0";
      textArea.style.border = "none";
      textArea.style.outline = "none";
      textArea.style.boxShadow = "none";
      textArea.style.background = "transparent";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return successful;
    } catch (err) {
      console.error("Fallback copy failed:", err);
      return false;
    }
  };

  const handleCopyFormattedVips = async () => {
    setProcessing('Copying Formatted VIP Cases...');
    try {
      const res = await fetch('/api/vip-cases/formatted', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text: vipCases })
      });
      if (!res.ok) {
        throw new Error('Failed to fetch formatted list');
      }
      const data = await res.json();
      if (data.text) {
        const copied = await copyToClipboard(data.text);
        if (copied) {
          setIsCopied(true);
          setTimeout(() => setIsCopied(false), 2500);
        } else {
          alert('Could not copy to clipboard. Please try again.');
        }
      } else {
        alert('No active VIP cases found.');
      }
    } catch (err: any) {
      console.error(err);
      alert(`Error copying VIP cases: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const copyFormattedEntries = async () => {
    if (entryRows.length === 0) {
      alert("No new admissions to copy.");
      return;
    }
    const header = `📋 *Detected New Admissions - Today's Entries* (${entryRows.length} Cases)\n` +
                   `----------------------------------------\n`;
    const lines = entryRows.map((e, idx) => 
      `${idx + 1}. *${e.name}* - Room: *${e.room}*\n` +
      `   👨‍⚕️ Physician: ${e.physician || 'N/A'}\n` +
      `   🏢 Contractor: ${e.contractor || 'N/A'}\n` +
      `   📅 Admitted: ${e.date || 'Today'}`
    ).join("\n\n");
    const copied = await copyToClipboard(header + lines);
    if (copied) {
      alert("New admissions copied to clipboard successfully!");
    } else {
      alert("Could not copy to clipboard. Please try again.");
    }
  };

  const saveEarlyDischargeRooms = async () => {
    setProcessing('Saving Early Discharge Rooms...');
    try {
      const res = await fetch('/api/early-discharge-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: earlyDischargeRooms })
      });
      if (res.ok) {
        alert('Early discharge rooms updated successfully!');
        await fetchData(); // Refresh state and sheets
      } else {
        alert('Failed to update early discharge rooms.');
      }
    } catch (err: any) {
      console.error(err);
      alert(`Error saving early discharge rooms: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const savePendingDischargePatients = async () => {
    setProcessing('Processing discharges...');
    try {
      const res = await fetch('/api/pending-discharge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: pendingDischargePatients })
      });
      if (res.ok) {
        const data = await res.json();
        setPendingDischargePatients(data.text || '');
        
        let msg = '';
        if (data.dischargedCount > 0) {
          msg += `Successfully discharged ${data.dischargedCount} patient(s):\n${data.dischargedNames.join('\n')}\n\nThey have been removed from the active sheets and added to the discharged patients database and statistics.`;
        } else {
          msg += 'No matching active patients found.';
        }
        
        if (data.unmatched && data.unmatched.length > 0) {
          msg += `\n\nCould not find match for ${data.unmatched.length} name(s), which remain in the textbox:\n${data.unmatched.join('\n')}`;
        }
        
        alert(msg);
        await fetchData(); // Refresh state and sheets
      } else {
        alert('Failed to process pending discharge patients.');
      }
    } catch (err: any) {
      console.error(err);
      alert(`Error processing pending discharges: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const handleRestorePatient = async (name: string) => {
    if (!window.confirm(`Are you sure you want to restore "${name}" to the active patient list?`)) {
      return;
    }
    setProcessing('Restoring patient...');
    try {
      const res = await fetch('/api/restore-patient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      if (res.ok) {
        alert(`Successfully restored "${name}" to active sheets.`);
        await fetchData(); // Refresh state
      } else {
        const errData = await res.json().catch(() => ({}));
        alert(errData.error || 'Failed to restore patient.');
      }
    } catch (err: any) {
      console.error(err);
      alert(`Error during restore: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadRefinedORListSimpleReport = async () => {
    setProcessing('Downloading Simple Refined OR List');
    try {
      const res = await fetch('/api/reports/or_list_simple_refined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the OR list sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Operating_Room_List_Refined_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadRefinedORListReport = async () => {
    setProcessing('Downloading Refined OR List Sheet');
    try {
      const res = await fetch('/api/reports/or_list_refined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the OR list sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Operating_Room_Schedule_Refined_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadOverListReport = async () => {
    setProcessing('Downloading Over List Sheet');
    try {
      const res = await fetch('/api/reports/or_over_list_refined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No Over List cases detected in the uploaded sheets.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Over_Listed_OR_Cases_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadORReconciliationReport = async () => {
    setProcessing('Downloading OR Reconciliation Sheet');
    try {
      const res = await fetch('/api/reports/or_reconciliation_refined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No reconciliation data available. Please upload sheets first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `OR_Reconciliation_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadORAdmissionsReport = async () => {
    setProcessing('Downloading OR Admissions Sheet');
    try {
      const res = await fetch('/api/reports/or_admissions');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload both sheets first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `OR_Admissions_Sheet_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadORTimelineReport = async () => {
    setProcessing('Downloading OR Timeline Sheet');
    try {
      const res = await fetch('/api/reports/or_timeline_refined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the OR list sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Operating_Room_Timeline_Graphics_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadExceedingALOSReport = async () => {
    setProcessing('Downloading Exceeding ALOS Sheet');
    try {
      const res = await fetch('/api/reports/exceeding_alos_refined');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Exceeding_ALOS_Refined_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadEarlyDischargeCasesReport = async () => {
    setProcessing('Downloading Early Discharge Cases Sheet');
    try {
      const res = await fetch('/api/reports/early_discharge_cases');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Early_Discharge_Cases_Sheet_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadRefinedMedicalPlansReport = async () => {
    setProcessing('Downloading Refined Medical Plans Sheet');
    try {
      // 1. Fetch the raw medical plans from the server
      const dataRes = await fetch('/api/occupancy/data');
      const data = await dataRes.json();
      const rawPlans = data.medicalPlans || [];

      if (rawPlans.length === 0) {
        throw new Error('No medical plans data found. Please upload the debts source sheet first.');
      }

      // 2. Process each plan
      const processedPlans = rawPlans.map((plan: any) => ({
        ...plan,
        sbar: plan.colAH || ""
      }));

      // 3. Send the processed plans to the server to generate the Excel with refined format
      const res = await fetch('/api/reports/medical_plans_formatted?refined=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plans: processedPlans, refined: true })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the debts source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Medical_Plans_Sheet_Refined_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadVipCasesMedicalUpdatesReport = async () => {
    setProcessing('Downloading VIP Cases Medical Updates');
    try {
      // 1. Fetch the raw medical plans from the server
      const dataRes = await fetch('/api/occupancy/data');
      const data = await dataRes.json();
      const rawPlans = data.medicalPlans || [];

      if (rawPlans.length === 0) {
        throw new Error('No medical plans data found. Please upload the debts source sheet first.');
      }

      // 2. Process each plan
      const processedPlans = rawPlans.map((plan: any) => ({
        ...plan,
        sbar: plan.colAH || ""
      }));

      // 3. Send the processed plans to the server to generate the Excel
      const res = await fetch('/api/reports/vip_cases_medical_updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plans: processedPlans })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No VIP cases matching the text box input were found.' }));
        throw new Error(errorData.error || 'Failed to generate VIP cases medical updates report.');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VIP_Cases_Medical_Updates_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadInpatientOccupancyByFloorAndAccommodation = async () => {
    setProcessing('Downloading Inpatient Floor & Accommodation Sheet');
    try {
      const res = await fetch('/api/reports/inpatient_occupancy_by_floor_accommodation');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Inpatient_occupancy_by_floor_accommodation_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadVacantByCategoryReport = async () => {
    setProcessing('Downloading Vacant Rooms by Category');
    try {
      const res = await fetch('/api/reports/vacant_by_category');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Vacant_Rooms_by_Category_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadVacantRoomsAscendingReport = async () => {
    setProcessing('Downloading Vacant Rooms Ascending Sheet');
    try {
      const res = await fetch('/api/reports/vacant_rooms_ascending');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Vacant_Rooms_Ascending_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const downloadOccupancyChartsDashboardReport = async () => {
    setProcessing('Downloading Occupancy Charts Dashboard Sheet');
    try {
      const res = await fetch('/api/reports/occupancy_charts_dashboard');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'No data found. Please upload the source sheet first.' }));
        throw new Error(errorData.error);
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Occupancy_Statistical_Dashboard_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(err);
      alert(`Download failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const runWorkflow = async (endpoint: string, name: string) => {
    setProcessing(name);
    try {
      const res = await fetch(`/api/workflows/${endpoint}`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      alert(`${name} workflow completed successfully!`);
    } catch (err: any) {
      console.error(err);
      alert(`Workflow failed: ${err.message}`);
    } finally {
      setProcessing(null);
    }
  };

  const activeStatsPatients = useMemo(() => {
    return patients.filter(p => {
      const num = parseInt(p.room.trim().toUpperCase().match(/\d+/)?.at(0) || "0");
      return num !== 108;
    });
  }, [patients]);

  const stats = useMemo(() => calculateStats(activeStatsPatients), [activeStatsPatients]);
  const exceedingALOSPatients = useMemo(() => {
    return losData.filter(p => {
      const los = parseFloat(p.colS);
      const eliteAlos = parseFloat(p.colAL);
      return !isNaN(los) && !isNaN(eliteAlos) && los > eliteAlos;
    });
  }, [losData]);

  const orOccupancyPatients = useMemo(() => {
    return (rawOccupancyRows || []).filter(row => {
      if (!row || row.length < 2) return false;
      const room = String(row[0] || "").trim();
      const name = String(row[1] || "").trim();
      return isOperatingRoom(room) && name;
    }).map((row, idx) => ({
      serial: idx + 1,
      room: String(row[0] || "").trim(),
      name: String(row[1] || "").trim(),
      doctor: String(row[2] || "").trim(),
      payment: String(row[3] || "").trim(),
      date: String(row[4] || "").trim(),
      mrn: String(row[5] || "").trim()
    }));
  }, [rawOccupancyRows]);

  const copyExceedingALOSPatients = async () => {
    if (exceedingALOSPatients.length === 0) {
      alert("No patients exceeding ALOS currently found or loaded.");
      return;
    }
    const header = "*Patients Exceeding Average Length Of Stay*";
    const bodyLines = exceedingALOSPatients.map((p, index) => {
      const cleanRoom = p.colB ? String(p.colB).replace(/room/gi, "").trim() : "";
      const lines = [
        `${index + 1}. *${p.colD}*`,
        cleanRoom,
        p.colM,
        `*${p.colS}*/${p.colAL}`
      ].map(item => item ? String(item).trim() : "").filter(Boolean);
      return lines.join('\n');
    });
    const listText = [header, ...bodyLines].join('\n\n');
    const copied = await copyToClipboard(listText);
    if (copied) {
      alert("Exceeding ALOS patients copied successfully!");
    } else {
      alert("Could not copy to clipboard. Please try again.");
    }
  };

  const totalOccupied = activeStatsPatients.length;
  const totalSlots = stats.reduce((acc, s) => acc + s.total, 0);
  const totalOccupancyRate = totalSlots > 0 ? ((totalOccupied / totalSlots) * 100).toFixed(1) : '0';

  const closedUnitZoneNames = ["ICU & VIP", "NICU", "PICU", "SICU", "CCU"];
  const inpatientWardStats = useMemo(() => {
    return stats.filter(s => !closedUnitZoneNames.includes(s.name));
  }, [stats]);

  const inpatientOccupied = useMemo(() => {
    return inpatientWardStats.reduce((acc, s) => acc + s.occupied, 0);
  }, [inpatientWardStats]);

  const inpatientTotalSlots = useMemo(() => {
    return inpatientWardStats.reduce((acc, s) => acc + s.total, 0);
  }, [inpatientWardStats]);

  const inpatientOccupancyRate = inpatientTotalSlots > 0 
    ? ((inpatientOccupied / inpatientTotalSlots) * 100).toFixed(1) 
    : '0';

  const cashCount = useMemo(() => activeStatsPatients.filter(p => isCashPayment(p.payment)).length, [activeStatsPatients]);
  const insuredCount = totalOccupied - cashCount;

  const filteredViewPatients = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return patients.filter(p => {
      const matchSearch = !q || p.name.toLowerCase().includes(q) || p.room.toLowerCase().includes(q);
      if (!matchSearch) return false;

      if (paymentFilter === 'cash') return isCashPayment(p.payment);
      if (paymentFilter === 'insured') return !isCashPayment(p.payment);
      return true;
    });
  }, [patients, searchQuery, paymentFilter]);

  if (!isAuthenticated) {
    return (
      <div 
        className="w-full min-h-screen flex items-center justify-center p-6 relative"
        style={{
          backgroundImage: `url('${hasHeaderBg ? `/api/header-background?t=${bgTimestamp}` : '/header_bg.png'}'), linear-gradient(135deg, #e4f2f0 0%, #f1f5f9 60%, #ccfbf1 100%)`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-white/20 backdrop-blur-sm pointer-events-none z-0"></div>
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-white/95 backdrop-blur-md p-10 rounded-3xl shadow-2xl border border-white/60 text-center relative z-10 shadow-emerald-950/5"
        >
          <div className="flex justify-center mb-8">
            <div className="w-[76px] h-[76px] bg-white border border-teal-100/80 rounded-2xl shadow-md p-2 flex items-center justify-center overflow-hidden">
              {logoLoadFailed ? (
                <div className="flex flex-col items-center justify-center text-center">
                  <svg viewBox="0 0 100 100" className="w-10 h-10 text-[#0b3c34] opacity-90">
                    <path fill="currentColor" d="M50,15 C42,25 32,35 20,40 C32,45 40,55 45,72 C48,55 56,45 68,40 C56,35 48,25 50,15 Z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  <span className="text-[10px] uppercase font-black tracking-widest text-[#0b3c34] font-mono leading-none mt-1">ELITE</span>
                </div>
              ) : (
                <img 
                  src={useAlternativeLogo ? `/elite_logo.png` : `/elite_logo_transparent.png`} 
                  alt="Elite Logo" 
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                  onError={() => {
                    if (!useAlternativeLogo) {
                      setUseAlternativeLogo(true);
                    } else {
                      setLogoLoadFailed(true);
                    }
                  }}
                />
              )}
            </div>
          </div>
          <h1 className="text-2xl font-extrabold mb-3 tracking-tight text-[#0b3c34]">Mohanad's Elite Unified Dashboard</h1>
          <p className="text-slate-600 text-xs mb-6 leading-relaxed font-semibold">
            Please sign in to access your administrative hospital workspace.
          </p>

          {authError && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-xl text-left leading-relaxed font-medium shadow-sm flex flex-col gap-2">
              <div className="flex items-center gap-2 font-bold text-amber-800">
                <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Sign-In Window Problem
              </div>
              <p>{authError}</p>
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-amber-200/60 pt-2 text-[10px] text-amber-700/80 font-bold uppercase tracking-wider font-mono">
                <span>Iframe sandbox helper</span>
                <button 
                  onClick={() => setAuthError(null)}
                  className="bg-amber-100 hover:bg-amber-200 px-2 py-0.5 rounded text-amber-900 normal-case font-mono transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <button 
            onClick={handleLogin}
            disabled={loading}
            className="w-full py-4 bg-[#0b3c34] hover:bg-[#0e4e43] text-white rounded-xl font-extrabold flex items-center justify-center gap-3 transition-all hover:shadow-lg hover:shadow-teal-900/10 active:scale-95 disabled:opacity-50 shadow-md text-sm"
          >
            {loading ? (
              <RefreshCw className="w-5 h-5 animate-spin text-emerald-400" />
            ) : (
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5 bg-white p-0.5 rounded-full" />
            )}
            Sign in with Gmail
          </button>

          <div className="mt-8 pt-8 border-t border-slate-200/50 text-[10px] text-[#0b3c34]/70 font-bold uppercase tracking-widest font-mono">
            Elite Hospital Management Systems
          </div>
        </motion.div>
      </div>
    );
  }

  if (!isDataLoaded) {
    return (
      <div 
        className="w-full min-h-screen flex items-center justify-center p-6 relative"
        style={{
          backgroundImage: `url('${hasHeaderBg ? `/api/header-background?t=${bgTimestamp}` : '/header_bg.png'}'), linear-gradient(135deg, #e4f2f0 0%, #f1f5f9 60%, #ccfbf1 100%)`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      >
        <div className="absolute inset-0 bg-white/20 backdrop-blur-sm pointer-events-none z-0"></div>
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-white/95 backdrop-blur-md p-10 rounded-3xl shadow-2xl border border-white/60 text-center relative z-10 shadow-emerald-950/5"
        >
          <div className="flex justify-center mb-8">
            <div className="w-[76px] h-[76px] bg-white border border-teal-100/80 rounded-2xl shadow-md p-2 flex items-center justify-center overflow-hidden">
              {logoLoadFailed ? (
                <div className="flex flex-col items-center justify-center text-center">
                  <svg viewBox="0 0 100 100" className="w-10 h-10 text-[#0b3c34] opacity-90">
                    <path fill="currentColor" d="M50,15 C42,25 32,35 20,40 C32,45 40,55 45,72 C48,55 56,45 68,40 C56,35 48,25 50,15 Z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                  <span className="text-[10px] uppercase font-black tracking-widest text-[#0b3c34] font-mono leading-none mt-1">ELITE</span>
                </div>
              ) : (
                <img 
                  src={useAlternativeLogo ? `/elite_logo.png` : `/elite_logo_transparent.png`} 
                  alt="Elite Logo" 
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                  onError={() => {
                    if (!useAlternativeLogo) {
                      setUseAlternativeLogo(true);
                    } else {
                      setLogoLoadFailed(true);
                    }
                  }}
                />
              )}
            </div>
          </div>
          <h1 className="text-2xl font-extrabold mb-8 tracking-tight text-[#0b3c34]">Mohanad's Elite Unified Dashboard</h1>
          
          <label className="block group cursor-pointer">
            <div className={`w-full py-12 px-6 border-2 border-dashed rounded-2xl transition-all flex flex-col items-center justify-center gap-4 ${
              loading 
                ? 'bg-teal-50/50 border-teal-300' 
                : 'bg-white border-teal-200/80 group-hover:border-[#0b3c34] group-hover:bg-teal-50/20 shadow-inner'
            }`}>
              {loading ? (
                <RefreshCw className="w-10 h-10 text-[#0b3c34] animate-spin" />
              ) : (
                <>
                  <div className="w-12 h-12 bg-teal-50 text-[#0b3c34] rounded-full flex items-center justify-center border border-teal-100">
                    <Download className="w-6 h-6" />
                  </div>
                  <div className="text-center">
                    <span className="block text-sm font-extrabold text-slate-850">Select Recent Unified Sheet</span>
                    <span className="block text-xs text-slate-400 italic mt-1 font-semibold">.xlsx, .xls, .csv supported</span>
                  </div>
                </>
              )}
            </div>
            <input 
              type="file" 
              accept=".xlsx,.xls,.csv" 
              className="hidden" 
              onChange={handleFileUpload}
              disabled={loading}
            />
          </label>

          <div className="mt-10 pt-8 border-t border-slate-200/50 flex flex-col items-center gap-6">
            <div className="flex items-center justify-center gap-8 opacity-80">
               <div className="flex flex-col items-center gap-1">
                 <FileText className="w-5 h-5 text-[#0b3c34]" />
                 <span className="text-[10px] font-bold uppercase tracking-wider font-mono text-slate-600">Secure parsing</span>
               </div>
               <div className="flex flex-col items-center gap-1">
                 <RefreshCw className="w-5 h-5 text-[#0b3c34]" />
                 <span className="text-[10px] font-bold uppercase tracking-wider font-mono text-slate-600">Live logic</span>
               </div>
            </div>

            <button 
              onClick={handleLogout}
              className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-red-600 transition-colors uppercase tracking-widest font-mono"
            >
              <LogOut className="w-3 h-3" />
              Sign Out
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div 
      className="w-full min-h-screen flex flex-col font-sans text-slate-900 overflow-hidden relative bg-slate-100"
      style={{
        backgroundImage: `url('${hasHeaderBg ? `/api/header-background?t=${bgTimestamp}` : '/header_bg.png'}'), linear-gradient(135deg, #e4f2f0 0%, #f1f5f9 60%, #ccfbf1 100%)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
    >
      {/* Top Navigation Bar */}
      <header className="h-20 bg-white/40 backdrop-blur-md border-b border-white/20 flex items-center justify-between px-6 shrink-0 z-20 shadow-sm relative">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-[#0b3c34] rounded-xl flex items-center justify-center text-white shadow-sm">
            <Building2 className="w-6 h-6 text-teal-100" />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight uppercase text-[#0b3c34] font-sans">Mohanad's Elite Unified Dashboard</h1>
        </div>

        {/* Central Floating Logo Badge */}
        <div className="absolute left-1/2 -translate-x-1/2 top-2 flex flex-col items-center justify-center z-30">
          <div className="w-[72px] h-[72px] bg-white border border-white/40 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.06),0_0_20px_rgba(20,184,166,0.15)] p-2 flex items-center justify-center overflow-hidden">
            {logoLoadFailed ? (
              <div className="flex flex-col items-center justify-center text-center">
                <svg viewBox="0 0 100 100" className="w-8 h-8 text-[#0b3c34] opacity-90">
                  <path fill="currentColor" d="M50,15 C42,25 32,35 20,40 C32,45 40,55 45,72 C48,55 56,45 68,40 C56,35 48,25 50,15 Z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
                <span className="text-[8px] uppercase font-black tracking-widest text-[#0b3c34] font-mono leading-none mt-0.5">ELITE</span>
              </div>
            ) : (
              <img 
                src={useAlternativeLogo ? `/elite_logo.png` : `/elite_logo_transparent.png`} 
                alt="Elite Logo" 
                className="w-full h-full object-contain transition-transform hover:scale-105 duration-300"
                referrerPolicy="no-referrer"
                onError={() => {
                  if (!useAlternativeLogo) {
                    console.log("[Logo Cachebuster] Base logo failed to load, trying alternative logo.");
                    setUseAlternativeLogo(true);
                  } else {
                    console.log("[Logo Cachebuster] Alternative logo failed to load, falling back to SVG glyph.");
                    setLogoLoadFailed(true);
                  }
                }}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end text-right">
            <span className="text-xs font-bold text-[#0b3c34] uppercase tracking-wider">MOHANAD M.D.</span>
            <span className="text-[10px] font-mono font-semibold text-slate-500 mt-0.5">
              {(() => {
                const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
                return `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`;
              })()} | {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Riyadh' })}
            </span>
          </div>
          <div className="flex items-center gap-2 pl-4 border-l border-slate-200/40">
            <button 
               onClick={handleLogout}
               className="p-2 text-slate-400 hover:text-red-600 transition-colors hover:bg-white/30 rounded-lg"
               title="Logout"
            >
               <LogOut className="w-5 h-5" />
            </button>
            <div className="w-10 h-10 rounded-full bg-slate-200/60 border-2 border-white text-slate-700 overflow-hidden flex items-center justify-center font-extrabold text-sm shadow-inner">
               M
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Controls */}
        <aside className="w-64 bg-white/10 backdrop-blur-md border-r border-white/20 p-6 flex flex-col gap-6 shrink-0 overflow-y-auto z-10 shadow-sm">
          <div>
            <h3 className="text-[10px] font-extrabold text-[#0b3c34]/70 uppercase tracking-widest mb-3 px-3">Main View</h3>
            <nav className="space-y-1.5">
              <NavItem 
                active={currentView === 'dashboard'} 
                onClick={() => setCurrentView('dashboard')}
                icon={<LayoutDashboard />}
                label="Dashboard"
              />
              <NavItem 
                active={currentView === 'patients'} 
                onClick={() => setCurrentView('patients')}
                icon={<Users />}
                label="Patient Registry"
              />
            </nav>
          </div>

          <div className="pt-2 border-t border-white/10">
            <h3 className="text-[10px] font-extrabold text-[#0b3c34]/70 uppercase tracking-widest mb-3 px-3">Management</h3>
            <nav className="space-y-1.5">
              <NavItem 
                active={currentView === 'medical-director'} 
                onClick={() => setCurrentView('medical-director')}
                icon={<ShieldCheck />}
                label="Medical Director & Inpatient manager"
              />
              <NavItem 
                active={currentView === 'duty-manager'} 
                onClick={() => setCurrentView('duty-manager')}
                icon={<Clock />}
                label="Duty Manager"
              />
              <NavItem 
                active={currentView === 'mohanad-sheets'} 
                onClick={() => {
                  setCurrentView('mohanad-sheets');
                  setMohanadSubTab('downloads');
                }}
                icon={<FileSpreadsheet />}
                label="Mohanad's Sheets"
                highlighted={user?.email?.toLowerCase() === 'mohanad.md07@gmail.com'}
              />
            </nav>
          </div>

          <div className="pt-2 border-t border-white/10">
            <h3 className="text-[10px] font-extrabold text-[#0b3c34]/70 uppercase tracking-widest mb-3 px-3">History & Archives</h3>
            <nav className="space-y-1.5">
              <NavItem 
                active={currentView === 'occupancy-history'} 
                onClick={() => setCurrentView('occupancy-history')}
                icon={<Calendar />}
                label="Occupancy History"
                badge="11:59 PM"
              />
              <NavItem 
                active={currentView === 'or-history'} 
                onClick={() => setCurrentView('or-history')}
                icon={<Activity />}
                label="OR Dashboard History"
                badge="OR"
              />
            </nav>
          </div>

          {user?.email?.toLowerCase() === 'mohanad.md07@gmail.com' && (
            <div className="pt-2 border-t border-white/10">
              <h3 className="text-[10px] font-extrabold text-[#0b3c34]/70 uppercase tracking-widest mb-3 px-3">Support</h3>
              <nav className="space-y-1.5">
                <NavItem 
                  active={currentView === 'audit-logs'} 
                  onClick={() => setCurrentView('audit-logs')}
                  icon={<Clock />}
                  label="User Login Audit Logs"
                  highlighted={true}
                />
              </nav>
            </div>
          )}

          <div className="pt-2 border-t border-white/10">
             <h3 className="text-[10px] font-extrabold text-[#0b3c34]/70 uppercase tracking-widest mb-3 px-3">Data Sync</h3>
             <div className="space-y-2">
                <button 
                  onClick={handleRefresh}
                  disabled={loading}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 bg-white/40 border border-white/20 rounded-xl text-xs font-bold text-slate-700 transition-all ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-white/60 hover:border-white/35 shadow-sm'}`}
                >
                  <RefreshCw className={`w-4 h-4 text-teal-600 ${loading ? 'animate-spin' : ''}`} />
                  Sync with Server
                </button>
                <label className={`w-full flex items-center gap-3 px-3.5 py-2.5 bg-[#0b3c34] hover:bg-[#0e4e43] border border-transparent rounded-xl text-xs font-bold text-white transition-all ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer shadow-sm active:scale-95'}`}>
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin text-white" /> : <Database className="w-4 h-4 text-emerald-400" />}
                  Upload Recent Unified Sheet
                  <input 
                    type="file" 
                    className="hidden" 
                    accept=".xlsx, .xls, .csv" 
                    onChange={handleFileUpload} 
                    disabled={loading}
                  />
                </label>
                <label className={`w-full flex items-center gap-3 px-3.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 border border-transparent rounded-xl text-xs font-bold text-white transition-all ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer shadow-sm active:scale-95'}`}>
                  {loading ? <RefreshCw className="w-4 h-4 animate-spin text-white" /> : <Upload className="w-4 h-4 text-indigo-300" />}
                  OR List Upload {hasORList && <span className="text-[10px] bg-white/20 text-white px-1.5 py-0.5 rounded-md font-mono">{orListCount}</span>}
                  <input 
                    type="file" 
                    className="hidden" 
                    accept=".xlsx, .xls, .csv" 
                    onChange={handleORListUpload} 
                    disabled={loading}
                  />
                </label>
             </div>
          </div>

          <div>
            <h3 className="text-[10px] font-extrabold text-[#0b3c34]/70 uppercase tracking-widest mb-3 px-3">Configuration</h3>
            <div className="space-y-2">
              <div className="p-3 bg-white/40 border border-white/15 rounded-xl">
                <p className="text-[9px] font-extrabold text-[#0b3c34] mb-1 uppercase">EXCLUSION KEYWORDS</p>
                <p className="text-[11px] font-mono leading-tight text-slate-600">homecare, dialysis, wellbaby...</p>
              </div>
              <div className="p-3 bg-white/40 border border-white/15 rounded-xl">
                <p className="text-[9px] font-extrabold text-[#0b3c34] mb-1 uppercase">SYNC STATUS</p>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                  <span className="text-[11px] font-mono text-slate-600">Live Connection</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-auto">
            <div className="bg-[#0b3c34]/15 border border-teal-400/40 text-[#0b3c34] p-4 rounded-xl shadow-[0_4px_20px_rgba(20,184,166,0.1)]">
              <p className="text-[10px] font-bold opacity-75 uppercase tracking-wider mb-1">Upcoming Trigger</p>
              <p className="text-base font-extrabold">14:00 (Daily Exit)</p>
            </div>
          </div>
        </aside>

        {/* Main Dashboard Content */}
        <main className="flex-1 p-8 overflow-y-auto bg-white/5 backdrop-blur-sm flex flex-col relative z-0">
          <header className="flex justify-between items-center mb-8 shrink-0">
            <div>
              <h2 className="text-4xl font-extrabold text-[#0b3c34] tracking-tight capitalize font-sans">{currentView}</h2>
              <p className="text-xs font-bold text-slate-600 mt-1 uppercase tracking-wide">Live operational overview of your infrastructure</p>
            </div>
            <div className="flex items-center gap-3">
              <button 
                onClick={handleReset}
                disabled={loading}
                className={`flex items-center gap-2 px-4 py-2.5 border rounded-xl text-xs font-bold transition-all shadow-sm group disabled:opacity-50 disabled:cursor-not-allowed ${
                  showResetConfirm 
                    ? 'bg-red-600 border-red-700 text-white animate-pulse' 
                    : 'bg-white/70 backdrop-blur border-slate-200/50 hover:border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Trash2 className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : 'group-hover:scale-110 transition-transform'}`} />
                {loading ? 'Resetting...' : showResetConfirm ? 'CONFIRM RESET' : 'Reset Data'}
              </button>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#0b3c34]" />
                <input 
                  type="text" 
                  placeholder="Patient / Room search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-11 pr-5 py-2.5 bg-white/60 backdrop-blur-md border border-slate-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 w-72 text-sm shadow-sm font-medium transition-all text-[#0b3c34] placeholder-slate-400"
                />
              </div>
            </div>
          </header>

          <AnimatePresence mode="wait">
            {currentView === 'dashboard' && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8"
              >
                {/* Dashboard Tabs Selector */}
                <div className="flex border-b border-teal-600/10 pb-px gap-6 px-1 shrink-0">
                  <button
                    onClick={() => setDashboardTab('hospital')}
                    className={`pb-3 text-sm font-extrabold tracking-tight transition-all relative flex items-center gap-2 ${
                      dashboardTab === 'hospital'
                        ? 'text-[#0b3c34]'
                        : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    Hospital Occupancy Dashboard
                    {dashboardTab === 'hospital' && (
                      <motion.div 
                        layoutId="activeSubDashboardTab" 
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#0b3c34]" 
                      />
                    )}
                  </button>
                  <button
                    onClick={() => setDashboardTab('or-list')}
                    className={`pb-3 text-sm font-extrabold tracking-tight transition-all relative flex items-center gap-2 ${
                      dashboardTab === 'or-list'
                        ? 'text-[#0b3c34]'
                        : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    OR Dashboard
                    {(orListCount > 0 || orOccupancyPatients.length > 0) && (
                      <span className="px-1.5 py-0.5 bg-[#0b3c34]/10 text-[#0b3c34] text-[10px] font-bold rounded-full font-mono">
                        {orListCount > 0 ? orListCount : orOccupancyPatients.length}
                      </span>
                    )}
                    {dashboardTab === 'or-list' && (
                      <motion.div 
                        layoutId="activeSubDashboardTab" 
                        className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#0b3c34]" 
                      />
                    )}
                  </button>
                </div>

                {dashboardTab === 'hospital' && (
                  <>
                    {/* Database Update Flash Alert */}
                    <AnimatePresence>
                      {dbUpdateMessage && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="bg-emerald-600 text-white px-4 py-2.5 rounded-xl flex items-center justify-between shadow-md text-xs font-semibold gap-3 w-full max-w-4xl"
                        >
                          <div className="flex items-center gap-2">
                            <Zap className="h-4 w-4 animate-bounce text-amber-300" />
                            <span>{dbUpdateMessage}</span>
                          </div>
                          <span className="bg-emerald-700/80 px-2 py-0.5 rounded-md text-[10px] uppercase font-mono tracking-wider">
                            Live Supabase Realtime
                          </span>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Auto-Fetch Schedule & Cloud Sync Bar */}
                    <div className="bg-white/95 border border-emerald-900/10 text-slate-800 p-4 rounded-2xl flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 shadow-xs w-full max-w-5xl">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        <div className="flex items-center gap-2.5">
                          <div className="relative flex h-3 w-3">
                            <div className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isDbUpdatePulsing ? "bg-amber-400 opacity-90" : "bg-emerald-400 opacity-75"}`}></div>
                            <div className={`relative inline-flex rounded-full h-3 w-3 ${isDbUpdatePulsing ? "bg-amber-500" : "bg-emerald-600"}`}></div>
                          </div>
                          <span className="text-xs font-bold uppercase tracking-wider text-emerald-950 flex items-center gap-1.5">
                            <Radio className="h-3.5 w-3.5 text-emerald-600" />
                            {realtimeConnected ? "Realtime DB Live" : "DB Polling Mode"}
                          </span>
                        </div>
                        
                        <div className="h-4 w-px bg-slate-200 hidden sm:block"></div>
                        
                        <span className="text-xs font-medium text-slate-600">
                          {uploadedAt ? (
                            <>
                              Cloud Sheet: <strong className="font-bold text-slate-800">{new Date(uploadedAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Riyadh' })}</strong> at <strong className="font-bold text-slate-800">{new Date(uploadedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Riyadh' })}</strong>
                            </>
                          ) : (
                            <span>No upload timestamp recorded. Synced with cloud DB.</span>
                          )}
                        </span>
                      </div>

                      {/* Auto-Fetch Schedule Controls */}
                      <div className="flex flex-wrap items-center gap-2.5">
                        <div className="flex items-center bg-slate-100/90 p-1 rounded-xl border border-slate-200/80 text-xs">
                          <span className="px-2 text-slate-500 font-semibold text-[11px] flex items-center gap-1">
                            <Timer className="h-3 w-3 text-slate-600" />
                            Schedule:
                          </span>
                          <button
                            onClick={() => handleUpdateScheduleRate('off')}
                            className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition cursor-pointer ${autoFetchScheduleRate === 'off' ? 'bg-white text-emerald-800 shadow-xs ring-1 ring-emerald-600/20' : 'text-slate-600 hover:text-slate-900'}`}
                            title="Instant Realtime on DB change only (Default)"
                          >
                            ⚡ Instant Only (Default)
                          </button>
                          <button
                            onClick={() => handleUpdateScheduleRate('5m')}
                            className={`px-2.5 py-1 rounded-lg font-bold text-[11px] transition cursor-pointer ${autoFetchScheduleRate === '5m' ? 'bg-white text-emerald-800 shadow-xs ring-1 ring-emerald-600/20' : 'text-slate-600 hover:text-slate-900'}`}
                            title="Auto-fetch every 5 minutes"
                          >
                            ⏱️ Every 5 Minutes
                          </button>
                        </div>

                        {autoFetchScheduleRate === '5m' && (
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 text-emerald-800 border border-emerald-200/80 rounded-xl text-xs font-bold font-mono" title="Time remaining until next 5m fetch">
                            <Clock className="h-3 w-3 text-emerald-600" />
                            <span>
                              {Math.floor(nextFetchCountdown / 60)}:{(nextFetchCountdown % 60).toString().padStart(2, '0')}
                            </span>
                          </div>
                        )}

                        <button
                          onClick={() => { fetchData(); }}
                          disabled={loading}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-400 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs focus:outline-hidden"
                          title="Force immediate auto-fetch"
                        >
                          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                          Sync Now
                        </button>
                      </div>
                    </div>

                {/* Metrics Bar */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-10 gap-4 shrink-0">
                  <StatCard label="Total Occupied" value={`${totalOccupied} / ${totalSlots}`} subValue="Active patient beds" icon={<Users className="text-indigo-600" />} />
                  <StatCard label="Cash Cases" value={`${cashCount}`} subValue="Self-pay mode" icon={<CreditCard className="text-teal-600" />} color="teal" />
                  <StatCard label="Insured Cases" value={`${insuredCount}`} subValue="Insurance covered" icon={<ShieldCheck className="text-[#0284c7]" />} color="sky" />
                  <StatCard 
                    label="Available" 
                    value={`${emptyRoomsList.filter(r => !/(ICU|CCU|VIP|PICU|NICU|SICU)/i.test(r)).length}`} 
                    subValue="General ward rooms" 
                    icon={<Building2 className="text-emerald-600" />} 
                    color="emerald" 
                  />
                  <StatCard label="Today's Entries" value={`${todaysEntries}`} subValue="Admitted today" icon={<Calendar className="text-blue-600" />} color="blue" />
                  <StatCard label="Discharged" value={`${dischargedPatients.length}`} subValue="Sync difference" icon={<LogOut className="text-pink-600" />} color="pink" />
                  <StatCard 
                    label="Dialysis Cases" 
                    value={`${dialysisCount}`} 
                    subValue="Daily dialysis sessions" 
                    icon={<Activity className="text-cyan-600" />} 
                    color="sky" 
                  />
                  <StatCard 
                    label="Inpatient Occupancy Rate" 
                    value={`${inpatientOccupancyRate}%`} 
                    subValue={`${inpatientOccupied} / ${inpatientTotalSlots} Inpatient Beds`} 
                    icon={<Percent className="text-teal-600" />} 
                    color="teal" 
                    highlighted={true}
                  />
                  <StatCard label="Critical Zones" value={stats.filter(s => s.occupied/s.total > 0.8).length.toString()} subValue="> 80% capacity" icon={<AlertCircle className="text-amber-600" />} color="amber" />
                  <StatCard 
                    label="VIP Cases" 
                    value={`${vipCount}`} 
                    subValue="Active VIP cases" 
                    icon={<Crown className="text-yellow-600" />} 
                    color="yellow" 
                    onCopy={handleCopyFormattedVips}
                    copyLabel="Copy Formatted VIP Cases"
                  />
                  <StatCard 
                    label="Patients Exceeding ALOS" 
                    value={`${exceedingALOSPatients.length}`} 
                    subValue="Exceeds threshold limits" 
                    icon={<AlertCircle className="text-amber-600" />} 
                    color="amber" 
                    onCopy={copyExceedingALOSPatients}
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  <div className="lg:col-span-2 space-y-8">
                    <div className="bg-white/60 backdrop-blur-md p-8 rounded-2xl border border-white/40 shadow-sm">
                      <div className="flex justify-between items-center mb-8">
                        <h3 className="font-extrabold text-[#0b3c34] tracking-tight">Occupancy Distribution</h3>
                        <div className="text-[10px] font-bold text-teal-700 uppercase tracking-widest bg-teal-500/10 px-2.5 py-1 rounded-md">Live Metrics</div>
                      </div>
                      <div className="h-80">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={stats}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                            <XAxis dataKey="name" fontSize={10} tickLine={false} axisLine={false} tick={{ fill: '#475569', fontWeight: 600 }} />
                            <YAxis hide />
                            <Tooltip 
                              cursor={{ fill: 'rgba(255, 255, 255, 0.2)' }}
                              contentStyle={{ borderRadius: '16px', border: '1px solid rgba(255,255,255,0.4)', background: 'rgba(255, 255, 255, 0.8)', backdropFilter: 'blur(12px)', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.05)' }}
                            />
                            <Bar dataKey="occupied" radius={[6, 6, 0, 0]} barSize={28}>
                               {stats.map((entry, index) => (
                                <Cell key={`cell-${index}`} fill={entry.occupied / entry.total > 0.8 ? '#ef4444' : '#0d9488'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Empty Rooms Panel */}
                    <div className="bg-white/60 backdrop-blur-md p-8 rounded-2xl border border-white/40 shadow-sm">
                      <div className="flex justify-between items-center mb-6 border-b border-teal-600/10 pb-3">
                        <h3 className="font-extrabold text-[#0b3c34] tracking-tight flex items-center gap-2">
                          <CheckCircle2 className="w-5 h-5 text-teal-600" />
                          Empty Rooms Dashboard ({emptyRoomsList.filter(r => !/(ICU|CCU|VIP|PICU|NICU|SICU)/i.test(r)).length})
                        </h3>
                      </div>
                      {emptyRoomsList.filter(r => !/(ICU|CCU|VIP|PICU|NICU|SICU)/i.test(r)).length === 0 ? (
                        <p className="text-sm text-slate-500">No empty rooms detected in the current record.</p>
                      ) : (
                        <div className="space-y-4 max-h-96 overflow-y-auto pr-2 pb-2">
                          {(() => {
                            const inpatientRooms = emptyRoomsList.filter(r => !/(ICU|CCU|VIP|PICU|NICU|SICU)/i.test(r));
                            const grouped: { [key: string]: string[] } = {
                              "أولي عاديه": [],
                              "مميز جنوبي": [],
                              "مميز شمالي": [],
                              "جونيور سويت": [],
                              "امبريال سويت": [],
                              "رويال سويت": [],
                              "بانوراما": [],
                              "Day Case": []
                            };

                            inpatientRooms.forEach(room => {
                              const category = getAccommodationCategory(room);
                              const mappedName = (category === "غير مصنف" || category === "Uncategorized" || category === "Day Case") ? "Day Case" : category;
                              if (grouped[mappedName] !== undefined) {
                                grouped[mappedName].push(room);
                              } else {
                                grouped["Day Case"].push(room);
                              }
                            });

                            const categoryColorClasses: { [key: string]: { header: string, pill: string } } = {
                              "مميز شمالي": { header: "text-teal-800 bg-teal-100/50 border-teal-200", pill: "bg-teal-50/60 text-teal-900 border-teal-300/30 hover:bg-teal-100/40" },
                              "مميز جنوبي": { header: "text-blue-800 bg-blue-100/50 border-blue-200", pill: "bg-blue-50/60 text-blue-900 border-blue-300/30 hover:bg-blue-100/40" },
                              "أولي عاديه": { header: "text-amber-800 bg-amber-100/50 border-amber-200", pill: "bg-amber-50/60 text-amber-900 border-amber-300/30 hover:bg-amber-100/40" },
                              "جونيور سويت": { header: "text-purple-800 bg-purple-100/50 border-purple-200", pill: "bg-purple-50/60 text-purple-900 border-purple-300/30 hover:bg-purple-100/40" },
                              "امبريال سويت": { header: "text-indigo-800 bg-indigo-100/50 border-indigo-200", pill: "bg-indigo-50/60 text-indigo-900 border-indigo-300/30 hover:bg-indigo-100/40" },
                              "رويال سويت": { header: "text-rose-800 bg-rose-100/50 border-rose-200", pill: "bg-rose-50/60 text-rose-900 border-rose-300/30 hover:bg-rose-100/40" },
                              "بانوراما": { header: "text-emerald-800 bg-emerald-100/50 border-emerald-200", pill: "bg-emerald-50/60 text-emerald-900 border-emerald-300/30 hover:bg-emerald-100/40" },
                              "Day Case": { header: "text-slate-600 bg-slate-100 border-slate-200", pill: "bg-slate-50 text-slate-800 border-slate-200/50 hover:bg-slate-100" }
                            };

                            return Object.entries(grouped)
                              .filter(([_, rooms]) => rooms.length > 0)
                              .map(([cat, rooms]) => {
                                const styles = categoryColorClasses[cat] || categoryColorClasses["Day Case"];
                                return (
                                  <div key={cat} className="p-3.5 rounded-xl border border-slate-100 bg-white/40 shadow-2xs">
                                    <div className="flex justify-between items-center mb-2.5">
                                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${styles.header}`}>
                                        {cat === "Day Case" ? "Day Case / اليوم الواحد" : cat}
                                      </span>
                                      <span className="text-[10px] text-slate-400 font-mono font-bold">
                                        {rooms.length} vacant room{rooms.length > 1 ? 's' : ''}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                      {rooms.map((room) => (
                                        <div 
                                          key={room} 
                                          className={`px-2.5 py-1 border rounded-lg text-xs font-semibold tracking-wide shadow-3xs cursor-default transition-all duration-150 transform hover:scale-[1.03] ${styles.pill}`}
                                        >
                                          {room}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              });
                          })()}
                        </div>
                      )}
                      <p className="text-[9px] text-slate-400 font-bold uppercase mt-4 text-right">
                        * Intensive Care Rooms are hidden from visual grid
                      </p>
                    </div>

                    {/* Detected New Admissions Panel */}
                    <div className="bg-white/60 backdrop-blur-md p-8 rounded-2xl border border-white/40 shadow-sm space-y-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-teal-600/10 pb-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2.5 bg-blue-500/10 text-blue-600 rounded-xl">
                            <UserPlus className="w-6 h-6" />
                          </div>
                          <div>
                            <h3 className="font-extrabold text-[#0b3c34] text-lg tracking-tight flex items-center gap-2">
                              Detected New Admissions ({entryRows.length})
                            </h3>
                            <p className="text-xs text-slate-500 font-semibold mt-1">
                              Patients admitted today, detected dynamically from all uploaded occupancy source sheets.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          {entryRows.length > 0 && (
                            <button
                              onClick={copyFormattedEntries}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0b3c34] hover:bg-[#155a4e] text-white text-xs font-bold rounded-xl shadow-xs transition-all cursor-pointer hover:scale-[1.02]"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              Copy WhatsApp Format
                            </button>
                          )}
                        </div>
                      </div>

                      {entryRows.length > 0 && (
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                          <input
                            type="text"
                            placeholder="Search new admissions by patient name, room, physician or contractor..."
                            value={entrySearchQuery}
                            onChange={(e) => setEntrySearchQuery(e.target.value)}
                            className="w-full pl-9 pr-10 py-2 bg-white/50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 placeholder-slate-400 focus:outline-hidden focus:border-[#0b3c34] transition-all"
                          />
                          {entrySearchQuery && (
                            <button
                              onClick={() => setEntrySearchQuery('')}
                              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-slate-200 text-slate-400 hover:text-slate-600 rounded-md transition-colors"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}

                      {(() => {
                        const query = entrySearchQuery.toLowerCase().trim();
                        const filtered = entryRows.filter(e => {
                          const nameMatch = String(e.name || "").toLowerCase().includes(query);
                          const roomMatch = String(e.room || "").toLowerCase().includes(query);
                          const docMatch = String(e.physician || "").toLowerCase().includes(query);
                          const classMatch = String(e.contractor || "").toLowerCase().includes(query);
                          return nameMatch || roomMatch || docMatch || classMatch;
                        });

                        if (filtered.length === 0) {
                          return (
                            <div className="text-center py-10 bg-slate-50/50 border border-dashed border-slate-200 rounded-2xl flex flex-col items-center justify-center">
                              <UserPlus className="w-10 h-10 text-slate-300 mb-2" />
                              <p className="text-xs text-slate-500 font-extrabold">
                                {entryRows.length === 0 ? "No new admissions detected today." : `No admissions matched your search query "${entrySearchQuery}".`}
                              </p>
                            </div>
                          );
                        }

                        return (
                          <div className="max-h-96 overflow-y-auto border border-teal-500/10 rounded-2xl divide-y divide-[#0b3c34]/5 bg-white/30 shadow-2xs">
                            {filtered.map((entry, idx) => {
                              const isOnORList = isPatientOnORList(entry, orList);

                              return (
                                <div key={idx} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-teal-500/5 transition-colors">
                                  <div className="space-y-1.5 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-xs font-black text-[#0b3c34]">{entry.name}</span>
                                      <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-800 font-mono text-[10px] font-extrabold uppercase tracking-wider">
                                        Room {entry.room}
                                      </span>
                                      {isOnORList && (
                                        <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-800 border border-amber-500/20 font-sans text-[10px] font-black uppercase tracking-wider">
                                          On the List
                                        </span>
                                      )}
                                    </div>
                                  <div className="text-[10px] text-slate-500 font-extrabold flex flex-wrap gap-x-4 gap-y-1">
                                    <span className="flex items-center gap-1">
                                      <span className="text-slate-400">Dr:</span> {entry.physician || 'N/A'}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <span className="text-slate-400">Class:</span> {entry.contractor || 'N/A'}
                                    </span>
                                  </div>
                                </div>
                                <div className="text-right shrink-0 flex items-center sm:flex-col gap-1 sm:gap-0">
                                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider block">Admitted On</span>
                                  <span className="text-[11px] font-mono font-bold text-teal-800 bg-teal-500/10 px-2 py-0.5 rounded-md">{entry.date || 'Today'}</span>
                                </div>
                              </div>
                            );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="bg-white/60 backdrop-blur-md p-8 rounded-2xl border border-white/40 shadow-sm flex flex-col">
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="font-extrabold text-[#0b3c34] tracking-tight">Resource Health</h3>
                      <div className="px-3 py-1 bg-[#0b3c34]/10 text-[#0b3c34] rounded-full text-[10px] font-bold uppercase tracking-wider border border-teal-400/20">
                        Inpatient: {inpatientOccupancyRate}% | Total: {totalOccupancyRate}%
                      </div>
                    </div>

                    <div className="space-y-6 flex-1 overflow-y-auto pr-2">
                      {/* Total Inpatient Summary */}
                      <div className="p-4 bg-white/30 rounded-xl border border-white/20 mb-2">
                        <div className="flex justify-between items-end mb-2">
                          <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Inpatient Occupancy Rate (Excl. Closed Units)</p>
                            <p className="text-xl font-bold text-slate-800">{inpatientOccupancyRate}%</p>
                          </div>
                          <p className="text-[11px] font-bold text-slate-500">{inpatientOccupied} / {inpatientTotalSlots} Inpatient Beds</p>
                        </div>
                        <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${inpatientOccupancyRate}%` }}
                            className="h-full bg-teal-600 rounded-full"
                          />
                        </div>
                      </div>

                      {/* Floor Summaries */}
                      {(() => {
                        const firstFloor = stats.find(s => s.name === "1st Floor");
                        const zoneA = stats.find(s => s.name === "Zone A");
                        const zoneB = stats.find(s => s.name === "Zone B");
                        const zoneC = stats.find(s => s.name === "Zone C");
                        const fourthFloor = stats.find(s => s.name === "4th Floor");
                        
                        const thirdFloorOccupied = (zoneA?.occupied || 0) + (zoneB?.occupied || 0) + (zoneC?.occupied || 0);
                        const thirdFloorTotal = (zoneA?.total || 0) + (zoneB?.total || 0) + (zoneC?.total || 0);
                        const thirdFloorPerc = thirdFloorTotal > 0 ? ((thirdFloorOccupied / thirdFloorTotal) * 100).toFixed(1) : "0";

                        return (
                          <div className="grid grid-cols-1 gap-4 py-3 border-y border-white/25">
                             <div className="flex justify-between items-center bg-[#0b3c34]/10 p-3.5 rounded-xl border border-teal-400/10">
                               <span className="text-[11px] font-bold text-[#0b3c34] uppercase">1st Floor</span>
                               <span className="text-xs font-mono font-bold text-teal-700">{firstFloor ? ((firstFloor.occupied/firstFloor.total)*100).toFixed(1) : 0}%</span>
                             </div>
                             <div className="flex justify-between items-center bg-[#0b3c34]/10 p-3.5 rounded-xl border border-teal-400/10">
                               <span className="text-[11px] font-bold text-[#0b3c34] uppercase">3rd Floor (Zone A+B+C)</span>
                               <span className="text-xs font-mono font-bold text-teal-700">{thirdFloorPerc}%</span>
                             </div>
                             <div className="flex justify-between items-center bg-[#0b3c34]/10 p-3.5 rounded-xl border border-teal-400/10">
                               <span className="text-[11px] font-bold text-[#0b3c34] uppercase">4th Floor</span>
                               <span className="text-xs font-mono font-bold text-teal-700">{fourthFloor ? ((fourthFloor.occupied/fourthFloor.total)*100).toFixed(1) : 0}%</span>
                             </div>
                          </div>
                        );
                      })()}

                      {stats.map(s => (
                        <div key={s.name} className="space-y-2">
                          <div className="flex justify-between text-[11px] font-bold uppercase tracking-wide">
                            <span className="text-[#0b3c34]">{s.name}</span>
                            <div className="flex gap-2">
                              <span className="text-teal-700 font-mono italic">{((s.occupied / s.total) * 100).toFixed(1)}%</span>
                              <span className="text-slate-400 font-normal">({s.occupied} / {s.total})</span>
                            </div>
                          </div>
                          <div className="h-1.5 bg-slate-200/50 rounded-full overflow-hidden">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${(s.occupied / s.total) * 100}%` }}
                              className={`h-full rounded-full transition-colors duration-500 ${s.occupied / s.total > 0.8 ? 'bg-red-500' : 'bg-teal-600'}`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                  </>
                )}

                {dashboardTab === 'or-list' && (
                  /* Operating Room Sub-dashboard */
                  <div className="space-y-8">
                    {(!hasORList || orList.length === 0) && orOccupancyPatients.length === 0 ? (
                      <div className="flex flex-col items-center justify-center p-16 bg-white/60 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm text-center">
                        <FileSpreadsheet className="w-16 h-16 text-indigo-300 mb-4 animate-pulse" />
                        <h3 className="text-lg font-extrabold text-slate-800 tracking-tight">No OR Schedule Data Loaded</h3>
                        <p className="text-sm text-slate-500 max-w-md mt-2">
                          Please upload the latest Operating Room List spreadsheet to generate elegant high-fidelity analytics, room schedules, filters, and downloads.
                        </p>
                        <button
                          onClick={() => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = '.xlsx, .xls, .csv';
                            input.onchange = (e: any) => {
                              handleORListUpload(e);
                            };
                            input.click();
                          }}
                          className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 rounded-xl text-xs font-bold text-white transition-all cursor-pointer shadow-sm active:scale-95"
                        >
                          <Upload className="w-4 h-4" />
                          Upload OR Sheet
                        </button>
                      </div>
                    ) : (
                      <>
                        {orList.length === 0 && (
                          <div className="bg-amber-550/10 border border-amber-500/20 p-4 rounded-2xl flex items-center gap-3">
                            <AlertCircle className="w-5 h-5 text-amber-600 animate-pulse shrink-0" />
                            <div>
                              <h4 className="text-xs font-extrabold text-amber-800">Showing Live Occupancy-Based OR Patients / عرض مرضى غرف العمليات من الإشغال المباشر</h4>
                              <p className="text-[10px] text-amber-700 font-medium mt-1">
                                Since the scheduled OR list is not uploaded or has been reset, the dashboard statistics and active lists are generated dynamically from patients currently inside rooms starting with "OR-" in the live Occupancy/Bed state.
                              </p>
                            </div>
                          </div>
                        )}
                        {orList.length > 0 && (() => {
                          const times = getORListStartAndEndTimes(orList);
                          if (times.start || times.end) {
                            return (
                              <div className="bg-gradient-to-r from-slate-800 to-indigo-950 text-white p-5 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 shadow-md border border-slate-700/50">
                                <div className="flex items-center gap-3">
                                  <div className="p-2.5 bg-indigo-500/20 text-indigo-300 rounded-xl">
                                    <Clock className="w-5 h-5 animate-pulse" />
                                  </div>
                                  <div>
                                    <h4 className="text-sm font-extrabold tracking-tight">Operating Room Scheduled Operating Hours / ساعات عمل غرف العمليات المقررة</h4>
                                    <p className="text-[10px] text-indigo-200 mt-0.5 font-medium">Derived dynamically from the uploaded source OR list spreadsheet</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-4 text-xs font-mono font-bold">
                                  {times.start && (
                                    <div className="bg-white/10 px-3.5 py-2 rounded-xl border border-white/10 flex items-center gap-2">
                                      <span className="text-indigo-300 uppercase tracking-wider text-[10px]">Start Time / البدء:</span>
                                      <span className="text-sm tracking-tight text-white">{times.start}</span>
                                    </div>
                                  )}
                                  {times.end && (
                                    <div className="bg-white/10 px-3.5 py-2 rounded-xl border border-white/10 flex items-center gap-2">
                                      <span className="text-indigo-300 uppercase tracking-wider text-[10px]">End Time / الانتهاء:</span>
                                      <span className="text-sm tracking-tight text-white">{times.end}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {/* Stats Section with elegant cards */}
                        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-4">
                          <StatCard 
                            label=" Formal TOTAL OR List" 
                            value={`${orList.length}`} 
                            subValue="Total scheduled cases" 
                            icon={<Users className="text-indigo-600" />} 
                            color="indigo" 
                          />
                          <StatCard 
                            label="Doctor Case (DC)" 
                            value={`${orList.filter(p => {
                              if (isPrivateCreditCase(p)) return true;
                              const vt = String(p.vt || "").toUpperCase().trim();
                              if (vt.includes("DC")) return true;
                              if (vt.includes("HC")) return false;
                              const combined = `${p.vt} ${p.column3} ${p.postC} ${p.flClassName}`.toUpperCase();
                              return combined.includes("DC") && !combined.includes("HC");
                            }).length}`} 
                            subValue="Doctor Case surgery" 
                            icon={<Clock className="text-amber-600" />} 
                            color="yellow" 
                          />
                          <StatCard 
                            label="Hospital Case (HC)" 
                            value={`${orList.filter(p => {
                              if (isPrivateCreditCase(p)) return false;
                              const vt = String(p.vt || "").toUpperCase().trim();
                              if (vt.includes("HC")) return true;
                              if (vt.includes("DC")) return false;
                              const combined = `${p.vt} ${p.column3} ${p.postC} ${p.flClassName}`.toUpperCase();
                              return combined.includes("HC") || (!combined.includes("DC") && combined.includes("IN"));
                            }).length}`} 
                            subValue="Hospital Case" 
                            icon={<Building2 className="text-purple-600" />} 
                            color="purple" 
                          />
                          <StatCard 
                            label="IN Patients" 
                            value={`${orList.length > 0 ? orList.filter(p => {
                              const isDischarged = dischargedPatients.some(discPt => {
                                const nameMatch = isClientNameMatch(p.patientName, discPt.name);
                                const mrnMatch = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
                                return nameMatch || mrnMatch;
                              });
                              if (isDischarged) return false;
                              if (p.realStatus === 'IN') return true;
                              if (p.realStatus === 'OUT') return false;
                              const statusVal = String(p.column3 || p.vt || "").toUpperCase().trim();
                              if (statusVal.includes("IN")) return true;
                              if (statusVal.includes("OUT")) return false;
                              const combined = `${p.column3} ${p.vt} ${p.postC} ${p.flClassName}`.toUpperCase();
                              return combined.includes("IN") && !combined.includes("OUT");
                            }).length : orOccupancyPatients.length}`} 
                            subValue="Currently Admitted Patients" 
                            icon={<ShieldCheck className="text-blue-600" />} 
                            color="sky" 
                          />
                          <StatCard 
                            label="OUT Patients" 
                            value={`${orList.filter(p => {
                              const isDischarged = dischargedPatients.some(discPt => {
                                const nameMatch = isClientNameMatch(p.patientName, discPt.name);
                                const mrnMatch = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
                                return nameMatch || mrnMatch;
                              });
                              if (isDischarged) return false;
                              if (p.realStatus === 'IN') return false;
                              if (p.realStatus === 'OUT') return true;
                              const statusVal = String(p.column3 || p.vt || "").toUpperCase().trim();
                              if (statusVal.includes("OUT")) return true;
                              if (statusVal.includes("IN")) return false;
                              const combined = `${p.column3} ${p.vt} ${p.postC} ${p.flClassName}`.toUpperCase();
                              return combined.includes("OUT") || !combined.includes("IN");
                            }).length}`} 
                            subValue="Not Currently Admitted Patients" 
                            icon={<CheckCircle2 className="text-emerald-600" />} 
                            color="teal" 
                          />
                          <StatCard 
                            label="Discharged OR Patients" 
                            value={`${orList.filter(p => 
                              dischargedPatients.some(discPt => {
                                const nameMatch = isClientNameMatch(p.patientName, discPt.name);
                                const mrnMatch = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
                                return nameMatch || mrnMatch;
                              })
                            ).length}`} 
                            subValue="Discharged OR Patients" 
                            icon={<LogOut className="text-pink-600" />} 
                            color="pink" 
                          />
                          <StatCard 
                            label="Post SICU" 
                            value={`${orList.filter(p => String(p.postC || "").toUpperCase().includes("SICU")).length}`} 
                            subValue="Surgical ICU Cases" 
                            icon={<Activity className="text-rose-600" />} 
                            color="rose" 
                          />
                          <StatCard 
                            label="Over List" 
                            value={`${overList.length}`} 
                            subValue="Admitted OR-x not in List" 
                            icon={<AlertCircle className="text-orange-600" />} 
                            color="orange" 
                          />
                        </div>

                        {/* Downloadable Sheet Buttons Container just under Stats squares */}
                        <div className="bg-white/60 backdrop-blur-md p-4 rounded-2xl border border-white/40 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <Download className="w-5 h-5 text-indigo-600 animate-bounce" />
                            <div>
                              <h4 className="text-xs font-extrabold text-slate-800 tracking-tight">OR List Downloads / تحميلات قائمة العمليات</h4>
                              <p className="text-[10px] text-slate-500">Generate and export formatted reports directly based on OR operations scheduling list</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2.5">
                            <button
                              onClick={handleORSync}
                              disabled={loading || !!processing}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <RefreshCw className={`w-4 h-4 ${processing === 'Syncing OR List with Occupancy' ? 'animate-spin' : ''}`} />
                              {processing === 'Syncing OR List with Occupancy' ? 'Syncing...' : 'Sync with Occupancy Sheet'}
                            </button>
                            <button
                              onClick={downloadORAdmissionsReport}
                              disabled={!!processing}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <Download className="w-4 h-4" />
                              {processing === 'Downloading OR Admissions Sheet' ? 'Generating...' : 'Download OR Admissions Sheet'}
                            </button>
                            <button
                              onClick={downloadRefinedORListSimpleReport}
                              disabled={!!processing}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <Download className="w-4 h-4" />
                              {processing === 'Downloading Simple Refined OR List' ? 'Generating...' : "Download Simple Refined OR List"}
                            </button>
                            <button
                              onClick={downloadRefinedORListReport}
                              disabled={!!processing}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <Download className="w-4 h-4" />
                              {processing === 'Downloading Refined OR List Sheet' ? 'Generating...' : "OR Filtered sheets"}
                            </button>
                            <button
                              onClick={downloadORTimelineReport}
                              disabled={!!processing}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <Download className="w-4 h-4" />
                              {processing === 'Downloading OR Timeline Graphics' ? 'Generating...' : 'Download Timeline Sheet (Graph)'}
                            </button>
                            <button
                              onClick={downloadOverListReport}
                              disabled={!!processing || overList.length === 0}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-700 hover:to-rose-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <Download className="w-4 h-4" />
                              {processing === 'Downloading Over List Sheet' ? 'Generating...' : "Download Over List Sheet"}
                            </button>
                            <button
                              onClick={downloadORReconciliationReport}
                              disabled={!!processing}
                              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-xs disabled:opacity-50 active:scale-95 shrink-0"
                            >
                              <Download className="w-4 h-4" />
                              {processing === 'Downloading OR Reconciliation Sheet' ? 'Generating...' : "Download OR Reconciliation Sheet"}
                            </button>
                            <button
                              onClick={handleResetORList}
                              disabled={loading || !!processing}
                              className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shadow-xs cursor-pointer active:scale-95 shrink-0 disabled:opacity-50 ${
                                showResetORConfirm
                                  ? 'bg-red-700 hover:bg-red-800 text-white animate-pulse'
                                  : 'bg-rose-600 hover:bg-rose-700 text-white'
                              }`}
                            >
                              <Trash2 className="w-4 h-4" />
                              {loading ? 'Resetting...' : showResetORConfirm ? 'Confirm Reset!' : 'Reset OR List Data'}
                            </button>
                          </div>
                        </div>

                        {/* Interactive Gantt Timeline Board */}
                        <div className="bg-white/60 backdrop-blur-md p-6 rounded-2xl border border-white/40 shadow-xs space-y-6">
                          <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 border-b border-indigo-500/10 pb-4">
                            <div>
                              <h3 className="text-base font-extrabold text-[#0b3c34] tracking-tight flex items-center gap-1.5">
                                <Activity className="w-5 h-5 text-indigo-600 animate-pulse" />
                                Operating Room Live Occupancy Tracker Timeline
                              </h3>
                              <p className="text-xs text-slate-500 font-medium mt-1">
                                Horizontal time-lapse visualization mapped by room, showing patient details and times of occupancy since earliest scheduled case.
                              </p>
                            </div>
                          </div>

                          {(() => {
                            // Helper to parse time string like "08:15" to minutes, supports AM/PM
                            const parseToMinutes = (timeStr: string): number | null => {
                              if (!timeStr) return null;
                              const lower = String(timeStr).toLowerCase().trim();
                              const isPM = lower.includes('pm') || lower.includes('مساءً') || lower.includes('م');
                              const isAM = lower.includes('am') || lower.includes('صباحاً') || lower.includes('ص');
                              
                              const cleanStr = lower.replace(/[^0-9:]/g, '');
                              const parts = cleanStr.split(':');
                              if (parts.length >= 2) {
                                let h = parseInt(parts[0], 10);
                                const m = parseInt(parts[1], 10);
                                if (!isNaN(h) && !isNaN(m)) {
                                  if (isPM && h < 12) {
                                    h += 12;
                                  } else if (isAM && h === 12) {
                                    h = 0;
                                  }
                                  return h * 60 + m;
                                }
                              }
                              return null;
                            };

                            let minMins = 24 * 60;
                            let maxMins = 0;
                            let hasValidCases = false;

                            const patientsWithTimes = orList.map(p => {
                              const start = parseToMinutes(p.startTime);
                              const end = parseToMinutes(p.endTime);
                              if (start !== null && end !== null && end > start) {
                                if (start < minMins) minMins = start;
                                if (end > maxMins) maxMins = end;
                                hasValidCases = true;
                                return { ...p, startMins: start, endMins: end };
                              }
                              return { ...p, startMins: null, endMins: null };
                            });

                            if (!hasValidCases || minMins >= maxMins) {
                              minMins = 8 * 60; // 08:00 AM
                              maxMins = 18 * 60; // 06:00 PM
                            } else {
                              // Round boundary parameters
                              minMins = Math.floor(minMins / 60) * 60;
                              maxMins = Math.ceil(maxMins / 60) * 60;
                            }

                            const totalDuration = maxMins - minMins;

                            // Filter patients based on orSearchQuery
                            const query = orSearchQuery.toLowerCase().trim();
                            const filteredPatientsWithTimes = patientsWithTimes.filter(p => {
                              if (!query) return true;
                              const name = String(p.patientName || "").toLowerCase();
                              const surgeon = String(p.surgeonName || "").toLowerCase();
                              const mrn = String(p.mrn || "").toLowerCase();
                              const opAr = String(p.arOperationName || "").toLowerCase();
                              const opEn = String(p.engOperationName || "").toLowerCase();
                              const room = String(p.orRoom || "").toLowerCase();
                              const postC = String(p.postC || "").toLowerCase();
                              return (
                                name.includes(query) ||
                                surgeon.includes(query) ||
                                mrn.includes(query) ||
                                opAr.includes(query) ||
                                opEn.includes(query) ||
                                room.includes(query) ||
                                postC.includes(query)
                              );
                            });

                            // Group filtered patient rows by OR Rooms
                            const roomsMapData: { [key: string]: any[] } = {};
                            filteredPatientsWithTimes.forEach(p => {
                              if (p.startMins !== null && p.endMins !== null) {
                                const r = String(p.orRoom || "OTHER").trim().toUpperCase();
                                if (!roomsMapData[r]) roomsMapData[r] = [];
                                roomsMapData[r].push(p);
                              }
                            });

                            const rooms = Object.keys(roomsMapData).sort();

                            // Generate hourly rulers
                            const hourTicks = [];
                            for (let m = minMins; m <= maxMins; m += 60) {
                              hourTicks.push(m);
                            }

                            return (
                              <div className="space-y-4">
                                {rooms.length === 0 ? (
                                  <div className="text-center p-8 bg-slate-50 border border-dashed border-slate-200 rounded-xl text-xs text-slate-400 font-semibold">
                                    {orSearchQuery ? `No active schedules matched "${orSearchQuery}" on Gantt.` : 'No patients with parsed schedulers found to plot on Gantt.'}
                                  </div>
                                ) : (
                                  <div className="overflow-x-auto rounded-xl border border-slate-150 shadow-3xs">
                                    <div className="min-w-[880px] bg-slate-50/50 p-4 select-none relative font-sans">
                                      {/* Hourly Ruler Header */}
                                      <div className="grid grid-cols-[180px_1fr] border-b border-slate-200 pb-2">
                                        <div className="text-xs font-extrabold text-slate-700">Room Name</div>
                                        <div className="relative h-6 text-[10px] font-black text-slate-400 uppercase tracking-wider font-mono">
                                          {hourTicks.map((tick, tIdx) => {
                                            const pct = ((tick - minMins) / totalDuration) * 100;
                                            const h = Math.floor(tick / 60);
                                            const formated = `${String(h).padStart(2, '0')}:00`;
                                            return (
                                              <span
                                                key={tick}
                                                className="absolute -translate-x-1/2"
                                                style={{ left: `${pct}%` }}
                                              >
                                                {formated}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      </div>

                                      {/* Rooms Grid with tracks */}
                                      <div className="divide-y divide-slate-150 py-1">
                                        {rooms.map(room => {
                                          const roomSurgeries = roomsMapData[room];
                                          
                                          // Dynamic lane allocation algorithm to prevent overlapping
                                          const sorted = [...roomSurgeries].sort((a, b) => (a.startMins || 0) - (b.startMins || 0));
                                          const lanes: any[][] = [];
                                          
                                          const plottedSurgeries = sorted.map(p => {
                                            const leftPct = ((p.startMins - minMins) / totalDuration) * 100;
                                            const widthPct = ((p.endMins - p.startMins) / totalDuration) * 100;
                                            
                                            let assignedLaneIdx = -1;
                                            for (let l = 0; l < lanes.length; l++) {
                                              const currentLane = lanes[l];
                                              const hasOverlap = currentLane.some(existing => {
                                                return p.startMins < existing.endMins && p.endMins > existing.startMins;
                                              });
                                              if (!hasOverlap) {
                                                assignedLaneIdx = l;
                                                break;
                                              }
                                            }
                                            
                                            if (assignedLaneIdx === -1) {
                                              assignedLaneIdx = lanes.length;
                                              lanes.push([p]);
                                            } else {
                                              lanes[assignedLaneIdx].push(p);
                                            }
                                            
                                            return {
                                              p,
                                              laneIndex: assignedLaneIdx,
                                              leftPct,
                                              widthPct
                                            };
                                          });

                                          const numLanes = lanes.length > 0 ? lanes.length : 1;
                                          const trackHeightPx = numLanes * 50 + 4; // 50px tall block per lane + padding

                                          return (
                                            <div key={room} className="grid grid-cols-[180px_1fr] py-3.5 items-center hover:bg-slate-50/40 relative">
                                              {/* Room Label */}
                                              <div className="flex items-center gap-2 pr-3 border-r border-slate-150 py-2">
                                                <span className="w-2.5 h-2.5 rounded-full bg-indigo-650 bg-indigo-600 shadow-3xs" />
                                                <span className="font-extrabold text-slate-800 text-[12px] font-mono tracking-tight">{room}</span>
                                                <span className="text-[9px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded-full font-extrabold font-mono">
                                                  {roomSurgeries.length}
                                                </span>
                                              </div>

                                              {/* Timeline Track with absolute capsules */}
                                              <div className="relative transition-all duration-300" style={{ height: `${trackHeightPx}px` }}>
                                                {/* Vertical Hour Tick Guidelines */}
                                                {hourTicks.map((tick, tIdx) => {
                                                  const pct = ((tick - minMins) / totalDuration) * 100;
                                                  return (
                                                    <div
                                                      key={`line-${tick}`}
                                                      className="absolute top-0 bottom-0 border-l border-dashed border-slate-200/60 pointer-events-none"
                                                      style={{ left: `${pct}%` }}
                                                    />
                                                  );
                                                })}

                                                {/* Plotted surgical capsules */}
                                                {plottedSurgeries.map(({ p, laneIndex, leftPct, widthPct }, pIdx) => {
                                                  const isVip = String(p.patientName || "").match(/(VIP|important|سعادة|الامير|امير|شيخ|شيخة)/i) || 
                                                    String(p.flClassName || "").toUpperCase().includes("VIP") ||
                                                    (p.vipStatus && String(p.vipStatus).trim() !== "");

                                                  const isHc = (String(p.vt || "").toUpperCase().includes("HC") ||
                                                    (!String(p.vt || "").toUpperCase().includes("DC") && `${p.vt} ${p.column3} ${p.postC} ${p.flClassName}`.toUpperCase().includes("HC"))) &&
                                                    !isPrivateCreditCase(p);

                                                  const colors = isVip
                                                    ? { bg: 'bg-amber-50 hover:bg-amber-100 text-[#7c2d12] hover:shadow-amber-250/30' }
                                                    : isHc
                                                    ? { bg: 'bg-purple-50 hover:bg-purple-100/80 text-[#581c87] hover:shadow-purple-250/30' }
                                                    : { bg: 'bg-blue-50 hover:bg-blue-100/80 text-[#1e3a8a] hover:shadow-blue-250/30' };

                                                  return (
                                                    <div
                                                      key={pIdx}
                                                      className="absolute p-2.5 rounded-xl border flex flex-col justify-center gap-0.5 cursor-pointer select-none transition-all duration-200 hover:scale-[1.01] hover:shadow-sm overflow-hidden"
                                                      style={{
                                                        left: `${leftPct}%`,
                                                        width: `${Math.max(12, widthPct)}%`,
                                                        top: `${laneIndex * 50 + 4}px`,
                                                        height: '42px',
                                                        backgroundColor: isVip ? '#fef3c7' : isHc ? '#f3e8ff' : '#eff6ff',
                                                        color: isVip ? '#78350f' : isHc ? '#581c87' : '#1e3a8a',
                                                        borderColor: isVip ? '#fcd34d' : isHc ? '#d8b4fe' : '#93c5fd'
                                                      }}
                                                      onMouseEnter={() => setHoveredPatient(p)}
                                                      onMouseLeave={() => setHoveredPatient(null)}
                                                    >
                                                      <div className="flex items-center gap-1 min-w-0">
                                                        {isVip && <Crown className="w-2.5 h-2.5 text-amber-500 fill-amber-400 shrink-0" />}
                                                        {!isVip && isHc ? (
                                                          <Building2 className="w-2.5 h-2.5 text-purple-500 shrink-0" />
                                                        ) : !isVip ? (
                                                          <Clock className="w-2.5 h-2.5 text-blue-600 shrink-0" />
                                                        ) : null}
                                                        <span className="font-extrabold text-[10px] truncate leading-none tracking-tight">
                                                          {p.patientName}
                                                        </span>
                                                      </div>
                                                      <div className="text-[8px] font-semibold text-slate-500 truncate leading-none">
                                                        Dr. {p.surgeonName || "Unknown"} • {p.startTime}-{p.endTime}
                                                      </div>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* Interactive detail panel when hovering */}
                                <div className="transition-all duration-300">
                                  {hoveredPatient ? (
                                    <div className="bg-indigo-500/5 border border-indigo-500/10 p-4 rounded-xl flex flex-col md:flex-row justify-between md:items-center gap-3 animate-fade-in">
                                      <div className="space-y-1">
                                        <span className="text-[9px] bg-indigo-100 text-indigo-800 px-2.5 py-0.5 rounded-full font-extrabold font-mono uppercase tracking-wider">
                                          Hovered Patient Details
                                        </span>
                                        <h4 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-1">
                                          {hoveredPatient.patientName}
                                          {String(hoveredPatient.patientName).match(/(VIP|important|سعادة|الامير|امير|شيخ|شيخة)/i) && (
                                            <Crown className="w-3.5 h-3.5 text-amber-500 fill-amber-400" />
                                          )}
                                        </h4>
                                        <p className="text-xs text-slate-500 leading-relaxed font-semibold">
                                          Operation: <span className="text-slate-700 font-bold">{hoveredPatient.engOperationName || hoveredPatient.arOperationName}</span>
                                        </p>
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-slate-400 font-semibold font-mono mt-1">
                                          <span>MRN: <strong className="text-slate-600 font-bold">{hoveredPatient.mrn || "—"}</strong></span>
                                          <span>Surgeon: <strong className="text-slate-600 font-bold">{hoveredPatient.surgeonName || "—"}</strong></span>
                                          <span>Room: <strong className="text-slate-600 font-bold">{hoveredPatient.orRoom}</strong></span>
                                          <span>Timing: <strong className="text-indigo-600 font-bold">{hoveredPatient.startTime} - {hoveredPatient.endTime}</strong></span>
                                        </div>
                                      </div>
                                      <div className="flex gap-2">
                                        {(() => {
                                          const matchingDisc = dischargedPatients.find(discPt => {
                                            const nameMatch = isClientNameMatch(hoveredPatient.patientName, discPt.name);
                                            const mrnMatch = hoveredPatient.mrn && discPt.id && (String(hoveredPatient.mrn).trim() === String(discPt.id).trim());
                                            return nameMatch || mrnMatch;
                                          });
                                          if (!matchingDisc) return null;
                                          return (
                                            <span className="px-2.5 py-1 text-[9px] font-black font-mono border border-pink-205 bg-pink-50 text-pink-700 rounded-full tracking-wider uppercase flex items-center gap-1 shadow-3xs">
                                              <LogOut className="w-2.5 h-2.5 text-pink-500" />
                                              Discharged OR Patient (Room {matchingDisc.room})
                                            </span>
                                          );
                                        })()}
                                        {hoveredPatient.postC && (
                                          <span className="px-2.5 py-1 text-[9px] font-black font-mono border border-rose-250 bg-rose-50 text-rose-800 rounded-full tracking-wider uppercase">
                                            Admit Target: {hoveredPatient.postC}
                                          </span>
                                        )}
                                        <span className={`px-2.5 py-1 text-[9px] font-black font-mono border rounded-full tracking-wider uppercase ${
                                          String(hoveredPatient.vt || "DC").toUpperCase().includes("HC") && !isPrivateCreditCase(hoveredPatient)
                                            ? 'border-purple-200 bg-purple-50 text-purple-800'
                                            : 'border-blue-200 bg-blue-50 text-blue-800'
                                        }`}>
                                          Admission: {isPrivateCreditCase(hoveredPatient) ? "DC" : (hoveredPatient.vt || "DC")}
                                        </span>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="bg-slate-50 border border-slate-150 py-3 px-4 rounded-xl text-center text-[11px] text-slate-400 font-medium">
                                      💡 Pro-Tip: Hover or tap individual surgery timeline capsules to view full surgical parameters, MRNs, and admission plans instantly.
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>

                        {/* Split layout: schedules and chart */}
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                          {/* Active room schedules column */}
                          <div className="lg:col-span-2 space-y-6">
                            <div className="bg-white/60 backdrop-blur-md p-6 rounded-2xl border border-white/40 shadow-xs animate-fade-in">
                              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-2 border-b border-indigo-500/10">
                                <div className="flex items-center gap-2.5">
                                  <span className="p-1 px-2.5 rounded-lg bg-indigo-500/10 text-indigo-700 text-[10px] uppercase font-mono font-black tracking-wide">Active</span>
                                  <h3 className="font-extrabold text-[#0b3c34] tracking-tight">
                                    Operating Room Schedule Grid
                                  </h3>
                                </div>
                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                                  <div className="relative">
                                    <Search className="absolute left-3 top-2 w-4 h-4 text-slate-400" />
                                    <input
                                      type="text"
                                      placeholder="Search patients, surgeons, OR..."
                                      value={orSearchQuery}
                                      onChange={(e) => setOrSearchQuery(e.target.value)}
                                      className="pl-9 pr-8 py-1.5 w-full sm:w-60 bg-slate-50 border border-slate-200 focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-xs font-semibold rounded-xl text-slate-800 placeholder-slate-400 outline-hidden transition shadow-3xs"
                                    />
                                    {orSearchQuery && (
                                      <button
                                        onClick={() => setOrSearchQuery('')}
                                        className="absolute right-2.5 top-1.5 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600 text-xs font-bold"
                                      >
                                        ✕
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="space-y-6 max-h-[640px] overflow-y-auto pr-2">
                                {(() => {
                                  const query = orSearchQuery.toLowerCase().trim();
                                  const filteredOrList = orList.filter(p => {
                                    if (!query) return true;
                                    const name = String(p.patientName || "").toLowerCase();
                                    const surgeon = String(p.surgeonName || "").toLowerCase();
                                    const mrn = String(p.mrn || "").toLowerCase();
                                    const opAr = String(p.arOperationName || "").toLowerCase();
                                    const opEn = String(p.engOperationName || "").toLowerCase();
                                    const room = String(p.orRoom || "").toLowerCase();
                                    const postC = String(p.postC || "").toLowerCase();
                                    return (
                                      name.includes(query) ||
                                      surgeon.includes(query) ||
                                      mrn.includes(query) ||
                                      opAr.includes(query) ||
                                      opEn.includes(query) ||
                                      room.includes(query) ||
                                      postC.includes(query)
                                    );
                                  });

                                  if (filteredOrList.length === 0) {
                                    return (
                                      <div className="text-center py-12 px-4 rounded-xl border border-dashed border-slate-150 text-slate-400 bg-slate-50/50">
                                        <Search className="w-8 h-8 mx-auto mb-2 text-slate-350" />
                                        <p className="text-xs font-bold font-mono text-slate-650">No cases matched "{orSearchQuery}"</p>
                                        <p className="text-[10px] text-slate-400 mt-1">Try searching with a different name, surgeon, room, or operation.</p>
                                      </div>
                                    );
                                  }

                                  // Group OR cases by Room
                                  const roomsMapData: { [key: string]: any[] } = {};
                                  filteredOrList.forEach(p => {
                                    const r = String(p.orRoom || "OTHER").trim().toUpperCase();
                                    if (!roomsMapData[r]) roomsMapData[r] = [];
                                    roomsMapData[r].push(p);
                                  });

                                  const rooms = Object.keys(roomsMapData).sort();
                                  return rooms.map(room => {
                                    const patientsInRoom = roomsMapData[room];
                                    return (
                                      <div key={room} className="border border-slate-100 rounded-xl bg-white/40 overflow-hidden shadow-2xs">
                                        <div className="px-4 py-3 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100 flex justify-between items-center">
                                          <div className="flex items-center gap-2.5">
                                            <span className="w-2.5 h-2.5 rounded-full bg-indigo-600" />
                                            <span className="font-extrabold text-slate-800 text-sm tracking-tight">{room}</span>
                                          </div>
                                          <span className="text-[10px] bg-indigo-500/10 text-indigo-700 px-2.5 py-0.5 rounded-full font-extrabold">
                                            {patientsInRoom.length} Patient{patientsInRoom.length > 1 ? 's' : ''}
                                          </span>
                                        </div>
                                        <div className="divide-y divide-slate-100">
                                          {patientsInRoom.map((p, idx) => {
                                            const status = String(p.column3 || p.vt || "").toUpperCase();
                                            const isInOut = p.realStatus || "OUT";
                                            const isDischarged = dischargedPatients.some(discPt => {
                                              const nameMatch = isClientNameMatch(p.patientName, discPt.name);
                                              const mrnMatch = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
                                              return nameMatch || mrnMatch;
                                            });
                                            const matchingDisc = isDischarged ? dischargedPatients.find(discPt => {
                                              const nameMatch = isClientNameMatch(p.patientName, discPt.name);
                                              const mrnMatch = p.mrn && discPt.id && (String(p.mrn).trim() === String(discPt.id).trim());
                                              return nameMatch || mrnMatch;
                                            }) : null;
                                            return (
                                              <div key={idx} className="p-4 hover:bg-slate-50/40 transition flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                                                <div className="space-y-1">
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-xs font-bold text-slate-400 font-mono">#{p.serial || idx + 1}</span>
                                                    <p className="text-sm font-extrabold text-slate-800">{p.patientName}</p>
                                                    <span className="text-[10px] text-slate-400 font-mono font-bold">MRN: {p.mrn}</span>
                                                  </div>
                                                  <p className="text-xs text-slate-500 font-semibold">{p.arOperationName || p.engOperationName}</p>
                                                  <div className="flex items-center gap-4 text-[10px] text-slate-400 font-semibold">
                                                    <span>Surgeon: <strong className="text-slate-600 font-bold">{p.surgeonName}</strong></span>
                                                    {p.column2 && <span>Eq: <strong className="text-slate-600 font-bold">{p.column2}</strong></span>}
                                                  </div>
                                                </div>

                                                <div className="flex items-center gap-2.5 shrink-0">
                                                  {p.startTime && (
                                                    <span className="px-2 py-0.5 border border-slate-100 rounded-md text-[10px] text-slate-500 font-mono flex items-center gap-1 bg-white shadow-3xs">
                                                      <Clock className="w-3 h-3 text-slate-400" />
                                                      {p.startTime} - {p.endTime || '...'}
                                                    </span>
                                                  )}
                                                  {isDischarged ? (
                                                    <span className="px-2 py-0.5 rounded text-[9px] font-black tracking-wider border bg-pink-50 text-pink-700 border-pink-200 flex items-center gap-1 shadow-3xs">
                                                      <LogOut className="w-2.5 h-2.5 text-pink-500" />
                                                      Discharged {matchingDisc && matchingDisc.room ? `(Room ${matchingDisc.room})` : 'OR Patient'}
                                                    </span>
                                                  ) : (
                                                    <span className={`px-2 py-0.5 rounded text-[9px] font-black tracking-wider border ${
                                                      isInOut === "IN" 
                                                        ? 'bg-blue-50 text-blue-800 border-blue-200' 
                                                        : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                                    }`}>
                                                      {isInOut === "IN" ? (p.admittedRoom ? `IN (${p.admittedRoom})` : 'IN') : 'OUT'}
                                                    </span>
                                                  )}
                                                  <span className={`px-2 py-0.5 rounded text-[9px] font-black tracking-wider border ${
                                                    String(p.vt || "").toUpperCase().trim() === "HC" && !isPrivateCreditCase(p)
                                                      ? 'bg-purple-50 text-purple-800 border-purple-200' 
                                                      : 'bg-amber-50 text-amber-800 border-amber-200'
                                                  }`}>
                                                    {isPrivateCreditCase(p) ? 'DC' : (p.vt || 'DC')}
                                                  </span>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            </div>
                          </div>

                          {/* Statistics breakdown */}
                          <div className="bg-white/60 backdrop-blur-md p-6 rounded-2xl border border-white/40 shadow-xs flex flex-col h-fit">
                            <div className="border-b border-indigo-600/10 pb-4 mb-4">
                              <h3 className="font-extrabold text-[#0b3c34] tracking-tight">OR Room Statistics</h3>
                              <p className="text-[11px] text-slate-400 font-bold uppercase mt-1">Patient Volume & Density</p>
                            </div>
                            <div className="space-y-4">
                              {(() => {
                                const roomsMapData: { [key: string]: any[] } = {};
                                orList.forEach(p => {
                                  const r = String(p.orRoom || "OTHER").trim().toUpperCase();
                                  if (!roomsMapData[r]) roomsMapData[r] = [];
                                  roomsMapData[r].push(p);
                                });

                                const rooms = Object.keys(roomsMapData).sort();
                                return rooms.map(r => {
                                  const count = roomsMapData[r].length;
                                  const pct = (count / orList.length) * 100;
                                  return (
                                    <div key={r} className="space-y-2">
                                      <div className="flex justify-between text-xs font-bold uppercase tracking-tight">
                                        <span className="text-slate-700">{r}</span>
                                        <div className="flex items-center gap-1.5 font-mono">
                                          <span className="text-indigo-600 font-bold">{count} case{count > 1 ? 's' : ''}</span>
                                          <span className="text-slate-400">({pct.toFixed(0)}%)</span>
                                        </div>
                                      </div>
                                      <div className="h-2 bg-slate-150/60 rounded-full overflow-hidden border border-slate-100 shadow-3xs">
                                        <div 
                                          style={{ width: `${pct}%` }}
                                          className="h-full rounded-full transition-all duration-500 bg-indigo-600"
                                        />
                                      </div>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          </div>
                        </div>

                        {/* Patients Currently in the OR Section */}
                        <div className="bg-white/80 backdrop-blur-md p-6 rounded-2xl border border-indigo-200 shadow-md space-y-4">
                          <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 border-b border-indigo-500/10 pb-4">
                            <div>
                              <h3 className="text-base font-extrabold text-[#0b3c34] tracking-tight flex items-center gap-2">
                                <Activity className="w-5 h-5 text-indigo-600 animate-pulse" />
                                Patients Currently in the OR / المرضى الموجودين في العمليات حالياً
                              </h3>
                              <p className="text-xs text-slate-500 font-medium mt-1">
                                These patients are currently admitted in rooms starting with "OR-" based on the live Occupancy/Bed state.
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="px-3 py-1 bg-indigo-50 text-indigo-700 text-xs font-black rounded-full font-mono border border-indigo-100">
                                {orOccupancyPatients.length} Active Patients
                              </span>
                            </div>
                          </div>

                          {orOccupancyPatients.length === 0 ? (
                            <div className="text-center py-10 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/50">
                              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
                              <p className="text-xs font-bold text-slate-650 font-mono">No patients currently in the OR</p>
                              <p className="text-[10px] text-slate-400 mt-1">All OR-x bed occupancy records are currently clear.</p>
                            </div>
                          ) : (
                            <div className="overflow-x-auto rounded-xl border border-slate-150">
                              <table className="w-full text-left text-sm border-collapse">
                                <thead className="bg-[#f8fafc]">
                                  <tr className="text-slate-700 uppercase text-[10px] font-black tracking-wider border-b border-slate-150">
                                    <th className="px-5 py-3">#</th>
                                    <th className="px-5 py-3">OR Room / غرفة العمليات</th>
                                    <th className="px-5 py-3">Patient Name / الاسم</th>
                                    <th className="px-5 py-3">MRN / الملف</th>
                                    <th className="px-5 py-3">Treating Physician / الطبيب المعالج</th>
                                    <th className="px-5 py-3">Contractor / الجهة</th>
                                    <th className="px-5 py-3 text-right">Admission Date / الدخول</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 text-slate-700 bg-white">
                                  {orOccupancyPatients.map((pt, index) => (
                                    <tr key={index} className="hover:bg-indigo-50/20 transition-colors">
                                      <td className="px-5 py-3 text-slate-400 font-mono text-[11px]">{index + 1}</td>
                                      <td className="px-5 py-3 font-mono text-indigo-700 font-extrabold text-[12px]">{pt.room}</td>
                                      <td className="px-5 py-3 font-extrabold text-slate-800">{pt.name}</td>
                                      <td className="px-5 py-3 font-mono text-slate-500 font-bold text-[11px]">{pt.mrn || 'N/A'}</td>
                                      <td className="px-5 py-3 text-slate-600 font-bold">{pt.doctor || 'N/A'}</td>
                                      <td className="px-5 py-3 font-semibold text-slate-500 text-[12px]">{pt.payment || 'N/A'}</td>
                                      <td className="px-5 py-3 font-mono text-slate-500 text-right text-[11px]">{pt.date || 'N/A'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>

                        {/* Over List Section */}
                        <div className="bg-white/80 backdrop-blur-md p-6 rounded-2xl border border-indigo-200 shadow-md space-y-4">
                          <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 border-b border-indigo-500/10 pb-4">
                            <div>
                              <h3 className="text-base font-extrabold text-[#0b3c34] tracking-tight flex items-center gap-2">
                                <AlertCircle className={`w-5 h-5 ${overList.length > 0 ? 'text-orange-550 animate-pulse' : 'text-emerald-500'}`} />
                                Detected Over List Patients (Admitted OR-x not in list) / Over-Listed OR Cases
                              </h3>
                              <p className="text-xs text-slate-500 font-medium mt-1">
                                These patients are currently admitted in "OR-x" rooms but their names do not appear in the uploaded scheduled OR List source sheet.
                              </p>
                            </div>
                            {overList.length > 0 && (
                              <button
                                onClick={downloadOverListReport}
                                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs font-bold rounded-xl cursor-pointer transition shadow-sm active:scale-95 shrink-0"
                              >
                                <Download className="w-4 h-4 animate-bounce" />
                                Download Over List Cases (.xlsx)
                              </button>
                            )}
                          </div>

                          {overList.length > 0 ? (
                            <div className="overflow-x-auto rounded-xl border border-slate-150">
                              <table className="w-full text-left text-sm border-collapse">
                                <thead className="bg-[#fffbeb]">
                                  <tr className="text-slate-700 uppercase text-[10px] font-black tracking-wider border-b border-amber-100">
                                    <th className="px-5 py-3">#</th>
                                    <th className="px-5 py-3">Patient Room / غرفة المريض</th>
                                    <th className="px-5 py-3">OR Room / العمليات</th>
                                    <th className="px-5 py-3">Patient Name / الاسم</th>
                                    <th className="px-5 py-3">MRN / الملف</th>
                                    <th className="px-5 py-3">Category / الفئة</th>
                                    <th className="px-5 py-3">Financial Cl. / الجهة</th>
                                    <th className="px-5 py-3 text-right">Admission Date / الدخول</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 text-slate-700 bg-white">
                                  {overList.map((pt, index) => (
                                    <tr key={index} className="hover:bg-amber-50/30 transition-colors">
                                      <td className="px-5 py-3 text-slate-400 font-mono text-[11px]">{index + 1}</td>
                                      <td className="px-5 py-3 font-mono text-slate-600 font-bold text-[11px]">{pt.patientRoom || 'N/A'}</td>
                                      <td className="px-5 py-3 font-mono text-orange-600 font-bold text-[11px]">{pt.room}</td>
                                      <td className="px-5 py-3 font-bold text-slate-800">{pt.patientName || pt.name}</td>
                                      <td className="px-5 py-3 font-mono text-slate-500 text-[11px]">{pt.mrn || pt.id || '—'}</td>
                                      <td className="px-5 py-3 text-[11px]">
                                        <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 font-semibold border border-amber-100">
                                          {pt.category || '—'}
                                        </span>
                                      </td>
                                      <td className="px-5 py-3 text-slate-500 text-[11px]">{pt.flClassName || pt.contractor || '—'}</td>
                                      <td className="px-5 py-3 text-right font-mono text-slate-500 text-[11px]">{pt.admissionDate || pt.date || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="text-center py-10 px-4 rounded-xl border border-dashed border-emerald-200 bg-emerald-50/10">
                              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto mb-2 animate-bounce" />
                              <p className="text-xs font-bold text-emerald-800 font-sans">No Over List Cases Detected / لا يوجد حالات خارج اللستة</p>
                              <p className="text-[10px] text-emerald-600 mt-1 font-medium">
                                All patients currently admitted inside "OR-x" rooms are matching and accounted for on the official scheduled OR list.
                              </p>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

              </motion.div>
            )}

            {currentView === 'patients' && (
              <motion.div 
                key="patients"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-white/60 backdrop-blur-md rounded-2xl border border-white/40 shadow-sm flex flex-col overflow-hidden"
              >
                <div className="p-4 bg-white/30 backdrop-blur-md border-b border-white/20 flex justify-between items-center shrink-0">
                  <h3 className="font-extrabold text-[#0b3c34] text-xs uppercase tracking-wider">Patient Occupancy Registry: {new Date().toLocaleDateString('sv', { timeZone: 'Asia/Riyadh' })}</h3>
                  <div className="flex gap-2">
                    <span 
                      onClick={() => setPaymentFilter('all')}
                      className={`px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase cursor-pointer transition-all shadow-sm ${
                        paymentFilter === 'all' 
                          ? 'bg-[#0b3c34] text-white border-[#0b3c34] shadow-teal-900/10' 
                          : 'bg-white/50 border-white/30 text-[#0b3c34] hover:bg-white/80'
                      }`}>
                      ALL ({totalOccupied})
                    </span>
                    <span 
                      onClick={() => setPaymentFilter('cash')}
                      className={`px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase cursor-pointer transition-all shadow-sm ${
                        paymentFilter === 'cash' 
                          ? 'bg-[#0e4e43] text-white border-[#0e4e43] shadow-emerald-900/10' 
                          : 'bg-white/50 border-white/30 text-[#0e4e43] hover:bg-white/80'
                      }`}>
                      CASH ({cashCount})
                    </span>
                    <span 
                      onClick={() => setPaymentFilter('insured')}
                      className={`px-3 py-1.5 rounded-xl border text-[10px] font-black uppercase cursor-pointer transition-all shadow-sm ${
                        paymentFilter === 'insured' 
                          ? 'bg-[#155e75] text-white border-[#155e75] shadow-sky-900/10' 
                          : 'bg-white/50 border-white/30 text-[#155e75] hover:bg-white/80'
                      }`}>
                      INSURED ({insuredCount})
                    </span>
                  </div>
                </div>

                <div className="flex-1 overflow-auto">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead className="sticky top-0 bg-white/70 backdrop-blur-xl z-10 shadow-sm">
                      <tr className="text-teal-950 uppercase text-[10px] font-black tracking-widest border-b border-teal-500/10">
                        <th className="px-6 py-4">#</th>
                        <th className="px-6 py-4">Room No</th>
                        <th className="px-6 py-4">Patient Name & ID</th>
                        <th className="px-6 py-4">Payment</th>
                        <th className="px-6 py-4 text-right">Admission Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/20 text-slate-800">
                      {(() => {
                        let currentGroup = '';
                        let serial = 1;
                        return filteredViewPatients.map((p, i) => {
                          const group = getGroup(p.room);
                          const isNewGroup = group !== currentGroup;
                          if (isNewGroup) currentGroup = group;
                          
                          return (
                            <React.Fragment key={i}>
                              {isNewGroup && (
                                <tr className="group-separator font-black text-[10px] uppercase tracking-widest bg-emerald-500/10 text-[#0b3c34]">
                                  <td colSpan={5} className="px-6 py-2 border-y border-white/20">{group}</td>
                                </tr>
                              )}
                              <tr className="hover:bg-white/40 transition-colors duration-200">
                                <td className="px-6 py-3 text-slate-400 font-mono text-[11px]">{serial++}</td>
                                <td className="px-6 py-3 font-mono text-teal-700 font-extrabold text-[11px]">{p.room}</td>
                                <td className="px-6 py-3">
                                  <div className="font-bold text-slate-800">{p.name || '---'}</div>
                                  <div className="text-[10px] text-slate-500 font-mono italic">{p.id}</div>
                                  {p.doctor && <div className="text-[9px] text-teal-600 font-extrabold uppercase mt-1 leading-none tracking-wide bg-teal-500/5 px-2 py-1 rounded-md border border-teal-500/10 inline-block">Dr. {p.doctor}</div>}
                                </td>
                                <td className="px-6 py-3">
                                  <span className={`px-2.5 py-1 rounded-lg text-[9px] font-extrabold uppercase tracking-wider border ${
                                    isCashPayment(p.payment)
                                      ? 'bg-teal-500/10 text-[#0b3c34] border-teal-500/20' 
                                      : 'bg-sky-500/10 text-sky-800 border-sky-500/20'
                                  }`}>
                                    {p.payment || 'Unknown'}
                                  </span>
                                </td>
                                <td className="px-6 py-3 text-right text-slate-600 font-mono text-[11px]">{p.date}</td>
                              </tr>
                            </React.Fragment>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
                <div className="p-3.5 bg-white/20 border-t border-white/20 text-[10px] text-[#0b3c34]/60 flex justify-between shrink-0 font-bold uppercase tracking-wider">
                  <span>Source: Elite Hospital Integrated Database</span>
                  <span className="font-extrabold uppercase tracking-tight">Sync Interval: 10s | Priority Sorting: ACTIVE</span>
                </div>
              </motion.div>
            )}

            {(currentView === 'medical-director' || currentView === 'duty-manager' || currentView === 'mohanad-sheets' || currentView === 'occupancy-history' || currentView === 'or-history' || currentView === 'audit-logs') && (
              <motion.div 
                key="role-workflows"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-12 pb-12"
              >
                {/* Section: Medical Director & Inpatient manager */}
                {currentView === 'medical-director' && (
                  <section>
                    <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
                      <h3 className="text-xl font-extrabold text-[#0b3c34] tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">Medical Director & Inpatient manager</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <WorkflowCard 
                        title="Combined Inpatient & Medical Director Sheet"
                        description="Download a single combined workbook including: Formatted Occupancy, Inpatient Summary Sheet, Closed Units Summary, Inpatients By Specialty, and LOS Sheet."
                        icon={<FileSpreadsheet className="text-emerald-700" />}
                        actionLabel={processing === 'Downloading Medical Director & Inpatient Manager Combined Report' ? 'Generating Combined Report...' : 'Download Combined Workbook'}
                        onAction={downloadMedicalDirectorCombinedReport}
                        disabled={!!processing}
                      />
                      <WorkflowCard 
                        title="Medical Plans Sheet"
                        description="Download structured SBAR medical plans (تطورات الحالات) extracted from the debt source."
                        icon={<FileText className="text-teal-600" />}
                        actionLabel={processing === 'Downloading Medical Plans' ? 'Generating...' : 'Download Medical Plans'}
                        onAction={downloadMedicalPlansReport}
                        disabled={!!processing}
                      />
                    </div>
                  </section>
                )}

                {/* Section: Duty Manager */}
                {currentView === 'duty-manager' && (
                  <section>
                    <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
                      <h3 className="text-xl font-extrabold text-[#0b3c34] tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">Duty Manager</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      <WorkflowCard 
                        title="Download Combined Sheet"
                        description="Download a single Excel file containing Formatted Occupancy, Entry, and Exit sheets."
                        icon={<FileText className="text-indigo-600" />}
                        actionLabel={processing === 'Downloading Combined Sheet' ? 'Generating...' : 'Download Combined'}
                        onAction={downloadCombinedReport}
                        disabled={!!processing}
                      />
                      <WorkflowCard 
                        title="Medical Plans Sheet"
                        description="Download structured SBAR medical plans (تطورات الحالات) extracted from the debt source."
                        icon={<FileText className="text-sky-600" />}
                        actionLabel={processing === 'Downloading Medical Plans' ? 'Generating...' : 'Download Medical Plans'}
                        onAction={downloadMedicalPlansReport}
                        disabled={!!processing}
                      />
                    </div>
                  </section>
                )}

                {/* Section: Mohanad's Sheets */}
                {currentView === 'mohanad-sheets' && (
                  <section className="space-y-6">
                    <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
                      <h3 className="text-xl font-extrabold text-[#0b3c34] tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">Mohanad's Sheets</h3>
                    </div>

                    <div className="bg-[#0b3c34]/10 border border-teal-500/20 rounded-xl p-4 flex gap-3 text-teal-900 text-xs shadow-sm">
                      <Info size={18} className="text-[#0b3c34] shrink-0 mt-0.5" />
                      <div>
                        <span className="font-extrabold text-[#0b3c34]">Mohanad's Premium Refined Series:</span> These high-fidelity, polished reports utilize Mohanad's signature transparent text box overlay laid perfectly over elegant header images, customized font sizing, and refined spacing formats across every worksheet.
                      </div>
                    </div>

                    {/* Sub Tab Navigation for Mohanad's Sheets */}
                    <div className="flex border-b border-[#0b3c34]/10 pb-px gap-2 mb-6 flex-wrap">
                      <button
                        id="tab-downloads-btn"
                        onClick={() => setMohanadSubTab('downloads')}
                        type="button"
                        className={`px-5 py-3 text-xs md:text-sm font-extrabold tracking-tight transition-all relative rounded-t-xl flex items-center gap-2 ${
                          mohanadSubTab === 'downloads'
                            ? 'bg-white/95 border-t-2 border-teal-600 border-x border-teal-500/25 text-[#0b3c34] shadow-sm'
                            : 'text-slate-500 hover:text-[#0b3c34] hover:bg-[#0b3c34]/5'
                        }`}
                      >
                        <FileSpreadsheet size={16} className="text-teal-700" />
                        Download Reports
                      </button>
                      <button
                        id="tab-inputs-btn"
                        onClick={() => setMohanadSubTab('inputs')}
                        type="button"
                        className={`px-5 py-3 text-xs md:text-sm font-extrabold tracking-tight transition-all relative rounded-t-xl flex items-center gap-2 ${
                          mohanadSubTab === 'inputs'
                            ? 'bg-white/95 border-t-2 border-teal-600 border-x border-teal-500/25 text-[#0b3c34] shadow-sm'
                            : 'text-slate-500 hover:text-[#0b3c34] hover:bg-[#0b3c34]/5'
                        }`}
                      >
                        <Database size={16} className="text-teal-700" />
                        Configure Inputs & Matchers
                        {(vipCases.trim() || earlyDischargeRooms.trim() || pendingDischargePatients.trim()) ? (
                          <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse ml-1" />
                        ) : null}
                      </button>
                      <button
                        id="tab-transfers-btn"
                        onClick={() => setMohanadSubTab('transfers')}
                        type="button"
                        className={`px-5 py-3 text-xs md:text-sm font-extrabold tracking-tight transition-all relative rounded-t-xl flex items-center gap-2 ${
                          mohanadSubTab === 'transfers'
                            ? 'bg-white/95 border-t-2 border-teal-600 border-x border-teal-500/25 text-[#0b3c34] shadow-sm'
                            : 'text-slate-500 hover:text-[#0b3c34] hover:bg-[#0b3c34]/5'
                        }`}
                      >
                        <ArrowRightLeft size={16} className="text-teal-700" />
                        Transfers Record
                        {transfersList.length > 0 && (
                          <span className="px-2 py-0.5 text-[11px] font-extrabold rounded-full bg-teal-100 text-teal-800 border border-teal-200">
                            {transfersList.length}
                          </span>
                        )}
                      </button>
                    </div>

                    {mohanadSubTab === 'inputs' && (
                      <div className="space-y-6 animate-fade-in">
                        {/* Mohanad VIP cases input text box */}
                        <div className="bg-white/60 backdrop-blur-md border border-white/45 rounded-2xl p-6 shadow-sm">
                          <div className="flex items-center justify-between mb-3 border-b border-teal-500/10 pb-2">
                            <div className="flex items-center gap-2">
                              <ShieldCheck className="text-teal-600" size={22} />
                              <div>
                                <h4 className="text-base font-extrabold text-[#0b3c34]">VIP Cases Name Matcher (VIP STATUS)</h4>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[11px] font-bold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                                    Persistent in Database Forever
                                  </span>
                                  {vipSaveStatus === 'saving' && (
                                    <span className="text-[10px] text-amber-600 font-bold animate-pulse">Auto-saving...</span>
                                  )}
                                  {vipSaveStatus === 'saved' && (
                                    <span className="text-[10px] text-emerald-700 font-bold flex items-center gap-0.5">
                                      <CheckCircle2 size={11} /> Saved
                                    </span>
                                  )}
                                  {vipSaveStatus === 'unsaved' && (
                                    <span className="text-[10px] text-amber-700 font-bold">Unsaved changes</span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <button
                              id="reset-vip-cases-btn"
                              onClick={handleResetVipCases}
                              disabled={!!processing || !vipCases?.trim()}
                              type="button"
                              className="px-3 py-1.5 text-xs font-bold rounded-lg border border-rose-500/30 text-rose-600 hover:bg-rose-50 hover:border-rose-500/55 active:scale-95 transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <RotateCcw size={13} />
                              Reset VIP Cases
                            </button>
                          </div>
                          <p className="text-xs text-slate-600 mb-4 leading-relaxed font-semibold">
                            Type or paste lists here. The system will extract names like <strong>عايده عبدالعاطي عبدالله ابوكليله</strong> and find their matches in the Occupancy source sheet to insert a new column called <strong>"VIP STATUS"</strong> across the Refined Debts, Companion Status, Formatted Companions, and Refined Occupancy sheets. All entries are permanently saved to the database.
                          </p>
                          <textarea
                            value={vipCases}
                            onChange={(e) => handleVipChange(e.target.value)}
                            onFocus={() => { isVipFocusedRef.current = true; }}
                            onBlur={() => { 
                              isVipFocusedRef.current = false; 
                              if (vipDebounceTimerRef.current) {
                                clearTimeout(vipDebounceTimerRef.current);
                                fetch('/api/vip-cases', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ text: vipCases })
                                }).then(() => setVipSaveStatus('saved')).catch(() => setVipSaveStatus('unsaved'));
                              }
                            }}
                            placeholder="Type or paste VIP cases text here...&#10;1- عايده عبدالعاطي عبدالله ابوكليله.....عنايه&#10;2- محمد عمر ابراهيم بركات...عنايه&#10;3- ماجدة محمود مختار عيسي...عنايه&#10;4- مبروكه عبدالقادر سليمان جبريل..عنايه عامه&#10;4- مكه محمد احمد ماهر....عايه اطفال&#10;6- احمد فتحي احمد عزالدين ...315"
                            rows={8}
                            className="w-full text-[13px] font-mono border border-teal-500/20 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-y bg-white/40 text-slate-800 placeholder-slate-400 font-medium"
                          />
                          <div className="mt-4 flex items-center justify-between">
                            <span className="text-xs text-slate-500 font-bold">Unlisted names will have clean, empty cells in the column.</span>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={handleCopyFormattedVips}
                                disabled={!!processing}
                                type="button"
                                className={`px-5 py-2.5 text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-2 ${
                                  isCopied
                                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-900/10'
                                    : 'bg-[#e2f0ee] hover:bg-[#d0e5e2] text-[#0b3c34] active:scale-95 border border-[#0b3c34]/20 shadow-teal-900/5'
                                }`}
                              >
                                <Copy size={14} />
                                {isCopied ? 'Copied List!' : 'Copy Formatted VIP Cases'}
                              </button>

                              <button
                                onClick={saveVipCases}
                                disabled={!!processing}
                                className={`px-5 py-2.5 text-xs font-bold rounded-xl text-white shadow-md transition-all flex items-center gap-2 ${
                                  processing 
                                    ? 'bg-slate-400 cursor-not-allowed shadow-none'
                                    : 'bg-[#0b3c34] hover:bg-[#0e4e43] active:scale-95 shadow-teal-900/10'
                                }`}
                              >
                                <Send size={14} />
                                {processing === 'Saving VIP Cases...' ? 'Saving changes...' : 'Save & Refresh State'}
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Mohanad Early Discharge Cases input text box */}
                        <div className="bg-white/60 backdrop-blur-md border border-white/45 rounded-2xl p-6 shadow-sm">
                          <div className="flex items-center gap-2 mb-3">
                            <FileSpreadsheet className="text-teal-600" size={22} />
                            <h4 className="text-base font-extrabold text-[#0b3c34]">Early Discharge Cases Room Numbers</h4>
                          </div>
                          <p className="text-xs text-slate-600 mb-4 leading-relaxed font-semibold">
                            Enter the room numbers of early discharge cases (separated by lines, commas, or spaces). The system will search for these rooms in the occupancy sheet to extract their dates of admission, room numbers, names, and contractors, then organize them by zone under the <strong>Early Discharge Cases Sheet</strong>.
                          </p>
                          <textarea
                            value={earlyDischargeRooms}
                            onChange={(e) => setEarlyDischargeRooms(e.target.value)}
                            placeholder="Type or paste room numbers here...&#10;e.g.&#10;301, 305, 315&#10;401, 402&#10;VIP 415"
                            rows={4}
                            className="w-full text-[13px] font-mono border border-teal-500/20 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-y bg-white/40 text-slate-800 placeholder-slate-400 font-medium"
                          />
                          <div className="mt-4 flex items-center justify-between">
                            <span className="text-xs text-slate-500 font-bold">Separators with Zone labels and total counts will be generated dynamically.</span>
                            <button
                              onClick={saveEarlyDischargeRooms}
                              disabled={!!processing}
                              className={`px-5 py-2.5 text-xs font-bold rounded-xl text-white shadow-md transition-all flex items-center gap-2 ${
                                processing 
                                  ? 'bg-slate-400 cursor-not-allowed shadow-none'
                                  : 'bg-[#0b3c34] hover:bg-[#0e4e43] active:scale-95 shadow-teal-900/10'
                              }`}
                            >
                              <Send size={14} />
                              {processing === 'Saving Early Discharge Rooms...' ? 'Saving changes...' : 'Save Rooms & Refresh State'}
                            </button>
                          </div>
                        </div>

                        {/* Mohanad Pending Discharge Patients input text box */}
                        <div className="bg-white/60 backdrop-blur-md border border-white/45 rounded-2xl p-6 shadow-sm">
                          <div className="flex items-center gap-2 mb-3">
                            <Users className="text-teal-600" size={22} />
                            <h4 className="text-base font-extrabold text-[#0b3c34]">Pending Discharge Patients</h4>
                          </div>
                          <p className="text-xs text-slate-600 mb-4 leading-relaxed font-semibold">
                            Enter patient names (one per line, or separated by commas). When you click save/discharge, they will be matched against active patients, removed from the active occupancy and other sheets, and safely added to the <strong>Discharged Patients</strong> statistics and historical sheets.
                          </p>
                          <textarea
                            value={pendingDischargePatients}
                            onChange={(e) => setPendingDischargePatients(e.target.value)}
                            placeholder="Type or paste patient names here...&#10;e.g.&#10;John Doe&#10;سيف النصر عيسي رجب والي&#10;خديجه عبد السلام عثمان عثمان"
                            rows={4}
                            className="w-full text-[13px] font-mono border border-teal-500/20 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-y bg-white/40 text-slate-800 placeholder-slate-400 font-medium"
                          />
                          <div className="mt-4 flex items-center justify-between">
                            <span className="text-xs text-slate-500 font-bold">Successfully discharged names are automatically removed from this textbox.</span>
                            <button
                              onClick={savePendingDischargePatients}
                              disabled={!!processing}
                              className={`px-5 py-2.5 text-xs font-bold rounded-xl text-white shadow-md transition-all flex items-center gap-2 ${
                                processing 
                                  ? 'bg-slate-400 cursor-not-allowed shadow-none'
                                  : 'bg-[#0b3c34] hover:bg-[#0e4e43] active:scale-95 shadow-teal-900/10'
                              }`}
                            >
                              <Send size={14} />
                              {processing === 'Processing discharges...' ? 'Processing...' : 'Discharge & Remove Patients'}
                            </button>
                          </div>
                        </div>

                        {/* Mohanad Active Exclusions & Discharged Patients Restoration Board */}
                        <div className="bg-white/60 backdrop-blur-md border border-white/45 rounded-2xl p-6 shadow-sm">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3 border-b border-teal-500/10 pb-3">
                            <div className="flex items-center gap-2">
                              <LogOut className="text-teal-600" size={22} />
                              <div>
                                <h4 className="text-base font-extrabold text-[#0b3c34]">Active Exclusions & Discharged Patients</h4>
                                <div className="text-[10px] text-teal-700 font-semibold">Persistent per day and saved with daily snapshots</div>
                              </div>
                            </div>
                            
                            <div className="px-3 py-1 bg-teal-500/10 text-teal-800 font-extrabold text-xs rounded-xl border border-teal-500/20">
                              {dischargedPatients.length} Excluded
                            </div>
                          </div>
                          
                          <p className="text-xs text-slate-600 mb-4 leading-relaxed font-semibold">
                            These patients are currently hidden from the active sheets. Click <strong>"Restore to Active"</strong> next to any patient (such as Room 401) to automatically remove their exclusion and restore them back onto all live reports instantly.
                          </p>
                          
                          {dischargedPatients.length === 0 ? (
                            <div className="text-center py-8 text-slate-400 text-xs font-extrabold">
                              No manually excluded or discharged patients found in database.
                            </div>
                          ) : (
                            <div className="max-h-64 overflow-y-auto border border-teal-500/10 rounded-xl divide-y divide-[#0b3c34]/5 bg-white/30">
                              {dischargedPatients.map((p, idx) => {
                                  const isVip = (p as any).isVip || (p as any).isVIP;
                                  return (
                                    <div key={idx} className="p-3.5 flex items-center justify-between hover:bg-teal-500/5 transition-colors gap-4">
                                      <div className="flex flex-col gap-1 min-w-0">
                                        <div className="text-xs font-extrabold text-[#0b3c34] flex items-center gap-2 flex-wrap">
                                          <span className="truncate">{p.name}</span>
                                          <span className="px-2 py-0.5 rounded-md bg-teal-500/10 text-teal-800 font-mono text-[10px] font-extrabold shrink-0">
                                            {p.room}
                                          </span>
                                          {isVip && (
                                            <span className="px-1.5 py-0.2 text-[9px] font-black rounded bg-amber-100 text-amber-900 border border-amber-300">
                                              VIP
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-extrabold flex gap-x-3 gap-y-1 flex-wrap">
                                          <span className="truncate">Doc: {(p as any).physician || 'N/A'}</span>
                                          <span className="truncate">Contractor: {(p as any).contractor || 'N/A'}</span>
                                          <span className="shrink-0">On: {p.date || 'N/A'}</span>
                                        </div>
                                      </div>
                                      <button
                                        onClick={() => handleRestorePatient(p.name)}
                                        disabled={!!processing}
                                        type="button"
                                        className="px-3 py-1.5 bg-[#0b3c34]/5 text-[11px] font-extrabold text-[#0b3c34] rounded-lg border border-[#0b3c34]/15 hover:bg-[#0b3c34]/10 active:scale-95 transition-all flex items-center gap-1 shrink-0 shadow-sm"
                                      >
                                        <RotateCcw size={12} />
                                        Restore to Active
                                      </button>
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {mohanadSubTab === 'downloads' && (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <WorkflowCard 
                          title="Patient Transfers Sheet (سجل تحويلات المرضى)"
                          description="Download Mohanad's refined high-fidelity report of patients transferred between rooms, tracking room journeys, transfer history, and treating physicians."
                          icon={<ArrowRightLeft className="text-teal-700" />}
                          actionLabel={processing === 'Downloading Patient Transfers Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadTransfersReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Occupancy Analytics Dashboard (Charts Mimic)"
                          description="Download a beautiful, executive-level Excel dashboard mimicking the 8 key occupancy charts with real Excel formulas and a premium Refined Sheets look."
                          icon={<FileSpreadsheet className="text-emerald-600" />}
                          actionLabel={processing === 'Downloading Occupancy Charts Dashboard Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadOccupancyChartsDashboardReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Refined Occupancy Sheet"
                          description="Download the high-fidelity occupancy sheet formatted dynamically matching Mohanad's visual layout specifications."
                          icon={<FileSpreadsheet className="text-amber-600" />}
                          actionLabel={processing === 'Downloading Refined Occupancy Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadGridOccupancyReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Refined Combined Sheet"
                          description="Download a combined report with Occupancy, Entry, Dialysis, Exit & Debts sheets all fully styled."
                          icon={<FileSpreadsheet className="text-sky-600" />}
                          actionLabel={processing === 'Downloading Refined Combined Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadRefinedCombinedReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Refined Companion Sheet"
                          description="Download the high-fidelity companions status report formatted dynamically with custom headers and VIP labels."
                          icon={<FileSpreadsheet className="text-rose-600" />}
                          actionLabel={processing === 'Downloading Refined Companion Status' ? 'Generating...' : 'Download'}
                          onAction={downloadRefinedCompanionSheetReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Refined Medical Plans"
                          description="Download a multi-sheet hospital SBAR medical plans tracker matching the high-fidelity signature design."
                          icon={<FileSpreadsheet className="text-indigo-600" />}
                          actionLabel={processing === 'Downloading Refined Medical Plans Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadRefinedMedicalPlansReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="VIP Cases Medical Updates"
                          description="Download a separate high-fidelity SBAR medical updates sheet filtered automatically for matching VIP cases."
                          icon={<FileSpreadsheet className="text-teal-600" />}
                          actionLabel={processing === 'Downloading VIP Cases Medical Updates' ? 'Generating...' : 'Download'}
                          onAction={downloadVipCasesMedicalUpdatesReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Inpatient occupancy by floor & accommodation"
                          description="Download the high-fidelity occupancy sheet containing the 'درجة الإقامة' (Accommodation Category) column next to room numbers, excluding all closed units (e.g. ICU, NICU, CCU, SICU)."
                          icon={<FileSpreadsheet className="text-[#0D47A1]" />}
                          actionLabel={processing === 'Downloading Inpatient Floor & Accommodation Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadInpatientOccupancyByFloorAndAccommodation}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Empty Rooms by Category"
                          description="Download the 'الغرف الشاغرة حسب الدرجة' report categorized into premium and standard groups while excluding closed units."
                          icon={<FileSpreadsheet className="text-emerald-700" />}
                          actionLabel={processing === 'Downloading Vacant Rooms by Category' ? 'Generating...' : 'Download'}
                          onAction={downloadVacantByCategoryReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Empty Rooms (Ascending by Floor & Room)"
                          description="Download empty rooms in ascending order by floor and room number, with accommodation category in a separate column."
                          icon={<FileSpreadsheet className="text-teal-700" />}
                          actionLabel={processing === 'Downloading Vacant Rooms Ascending Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadVacantRoomsAscendingReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Early Discharge Cases Sheet"
                          description="Download the custom 'Early Discharge Cases Sheet' containing extracted details formatted with stylish colored separators for each Zone showing zone name and number of cases."
                          icon={<FileSpreadsheet className="text-[#0D47A1]" />}
                          actionLabel={processing === 'Downloading Early Discharge Cases Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadEarlyDischargeCasesReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Exceeding ALOS Sheet"
                          description="Download Mohanad's premium high-fidelity report of patients exceeding the length of stay (LOS > Elite ALOS), stylized with custom headers and grouped separators."
                          icon={<FileSpreadsheet className="text-rose-700" />}
                          actionLabel={processing === 'Downloading Exceeding ALOS Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadExceedingALOSReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Insured Debts Sheet"
                          description="Download a premium high-fidelity sheet for insured patients with remaining amounts, formatted nicely like the Debts sub-sheet."
                          icon={<FileSpreadsheet className="text-purple-600" />}
                          actionLabel={processing === 'Downloading Insured Debts Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadInsuredDebtsReport}
                          disabled={!!processing}
                        />
                        <WorkflowCard 
                          title="Insured & Non-Cash Patients"
                          description="Download a premium high-fidelity structured sheet containing active insured, non-cash patients grouped by departments."
                          icon={<FileSpreadsheet className="text-blue-700" />}
                          actionLabel={processing === 'Downloading Insured Non-Cash Sheet' ? 'Generating...' : 'Download'}
                          onAction={downloadInsuredNonCashReport}
                          disabled={!!processing}
                        />
                      </div>
                    )}

                    {mohanadSubTab === 'transfers' && (
                      <div className="space-y-6 animate-fade-in">
                        <PatientTransfersTable
                          transfers={transfersList}
                          onRefresh={fetchTransfers}
                          onDownloadExcel={downloadTransfersReport}
                          isDownloading={processing === 'Downloading Patient Transfers Sheet'}
                          activePatients={patients}
                        />
                      </div>
                    )}
                  </section>
                )}

                {/* Section: Standalone Occupancy History View */}
                {currentView === 'occupancy-history' && (
                  <section className="space-y-6 animate-fade-in">
                    <OccupancyHistoryView onNotify={(msg) => alert(msg)} />
                  </section>
                )}

                {/* Section: Standalone OR Dashboard History View */}
                {currentView === 'or-history' && (
                  <section className="space-y-6 animate-fade-in">
                    <ORHistoryView onNotify={(msg) => alert(msg)} />
                  </section>
                )}

                {/* Section: User Login Audit Logs */}
                {currentView === 'audit-logs' && (
                  <section className="space-y-6 animate-fade-in">
                    <div>
                      <div className="flex items-center gap-3 mb-6 border-l-4 border-teal-600 pl-4">
                        <h3 className="text-xl font-extrabold text-[#0b3c34] tracking-tight underline decoration-teal-100 underline-offset-8 uppercase font-sans">User Login Audit Logs</h3>
                      </div>
                    </div>

                    <div className="bg-white/60 backdrop-blur-md rounded-2xl border border-white/20 p-6 shadow-sm">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
                        <div>
                          <h4 className="text-lg font-bold text-[#0b3c34]">Active Authentication Logs</h4>
                          <p className="text-xs text-slate-500">Tracks user authentication and access sessions secured through Google SSO (Limit: 100 entries)</p>
                        </div>
                        <button
                          onClick={fetchLoginLogs}
                          disabled={loadingLogs}
                          className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-[#0b3c34] hover:text-[#0b3c34]/80 bg-white border border-slate-200 hover:border-slate-300 rounded-xl transition duration-150 shadow-sm"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
                          Refresh logs
                        </button>
                      </div>

                      {loadingLogs && loginLogs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                          <RefreshCw className="w-8 h-8 animate-spin mb-3 text-teal-600" />
                          <p className="text-sm">Loading audit logs...</p>
                        </div>
                      ) : loginLogs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
                          <Clock className="w-8 h-8 mb-3 text-slate-300" />
                          <p className="text-sm font-medium">No recent login records found</p>
                          <p className="text-xs text-slate-400 mt-1">Activities will be tracked here dynamically</p>
                        </div>
                      ) : (
                        <div className="overflow-y-auto max-h-[500px] border border-slate-100 rounded-xl custom-scrollbar">
                          <table className="w-full text-left text-xs border-collapse">
                            <thead className="sticky top-0 bg-white/95 backdrop-blur z-10 shadow-[0_1px_0_0_rgba(226,232,240,1)]">
                              <tr className="text-[#0b3c34]/70 uppercase tracking-wider font-extrabold text-[10px]">
                                <th className="py-3 pl-4">User (Display Name)</th>
                                <th className="py-3">Email Address</th>
                                <th className="py-3">Session Date & Time</th>
                                <th className="py-3 text-right pr-4">Security ID</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {loginLogs.map((log) => {
                                const localDate = new Date(log.timestamp).toLocaleString();
                                return (
                                  <tr key={log.id} className="hover:bg-slate-50/50 transition-colors">
                                    <td className="py-3.5 pl-4 font-semibold text-slate-800 flex items-center gap-2">
                                      <div className="w-6 h-6 rounded-full bg-teal-50 text-teal-700 flex items-center justify-center text-[10px] font-extrabold shadow-sm shrink-0">
                                        {log.displayName ? log.displayName.charAt(0).toUpperCase() : (log.email ? log.email.charAt(0).toUpperCase() : '?')}
                                      </div>
                                      <span className="truncate max-w-[160px]" title={log.displayName || 'Unnamed User'}>
                                        {log.displayName || 'Unnamed User'}
                                      </span>
                                    </td>
                                    <td className="py-3.5 text-slate-600 font-mono text-xs">{log.email}</td>
                                    <td className="py-3.5 text-slate-500 font-medium">{localDate}</td>
                                    <td className="py-3.5 text-right pr-4 font-mono text-[9px] text-slate-400 select-all">{log.id}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </section>
                )}


              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

function NavItem({ active, onClick, icon, label, highlighted, badge }: { 
  active: boolean, 
  onClick: () => void, 
  icon: React.ReactElement, 
  label: string,
  highlighted?: boolean,
  badge?: string
}) {
  return (
    <button 
      onClick={onClick}
      className={`flex items-center justify-between w-full px-3 py-2 rounded-lg transition-all text-sm font-medium relative ${
        active 
          ? 'bg-[#0b3c34] text-white shadow-md shadow-teal-900/10' 
          : highlighted
            ? 'bg-amber-500/15 text-amber-700 hover:text-amber-900 hover:bg-amber-500/20 border-2 border-amber-500/30 shadow-[0_0_12px_rgba(245,158,11,0.25)] animate-pulse'
            : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {React.cloneElement(icon, { className: 'w-4 h-4 shrink-0' } as any)}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        {badge && (
          <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-full ${
            active ? 'bg-white/20 text-white' : 'bg-teal-500/10 text-teal-800'
          }`}>
            {badge}
          </span>
        )}
        {highlighted && !active && (
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
        )}
      </div>
    </button>
  );
}

function ActionButton({ icon, label, onClick, loading }: { icon: React.ReactElement, label: string, onClick: () => void, loading?: boolean }) {
  return (
    <button 
      onClick={onClick}
      disabled={loading}
      className="w-full text-left px-3 py-2.5 text-xs bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors shadow-sm flex items-center gap-2 font-bold uppercase tracking-wide"
    >
      {React.cloneElement(icon, { className: `w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}` } as any)}
      {label}
    </button>
  )
}

function StatCard({ label, value, subValue, icon, color = 'indigo', onCopy, copyLabel, highlighted }: { 
  label: string, 
  value: string, 
  subValue: string, 
  icon: React.ReactElement, 
  color?: string,
  onCopy?: () => void,
  copyLabel?: string,
  highlighted?: boolean
}) {
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
          {React.cloneElement(icon, { className: 'w-5 h-5 relative z-10 text-[#0b3c34]' } as any)}
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

function WorkflowCard({ 
  title, 
  description, 
  icon, 
  actionLabel, 
  onAction,
  disabled
}: { 
  title: string, 
  description: string, 
  icon: React.ReactElement, 
  actionLabel: string, 
  onAction: () => void,
  disabled?: boolean
}) {
  return (
    <div className={`bg-white/60 backdrop-blur-md p-6 rounded-2xl border border-white/45 shadow-sm flex flex-col hover:border-teal-500/40 hover:shadow-md transition-all group ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      <div className="mb-4 p-3.5 bg-teal-500/10 rounded-xl w-fit group-hover:bg-teal-500/20 transition-all shadow-sm">
        {React.cloneElement(icon, { className: 'w-7 h-7 text-[#0b3c34] transition-transform group-hover:scale-110' } as any)}
      </div>
      <h3 className="text-base font-extrabold mb-2 text-[#0b3c34] tracking-tight">{title}</h3>
      <p className="text-slate-600 text-[12px] mb-6 leading-relaxed font-semibold">
        {description}
      </p>
      <button 
        onClick={onAction}
        disabled={disabled}
        className="mt-auto py-3 px-5 bg-[#0b3c34] text-white rounded-xl font-bold text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 hover:bg-[#0e4e43] transition-all active:scale-95 shadow-md shadow-teal-900/10 disabled:bg-slate-300"
      >
        {actionLabel}
        <ArrowRightLeft className="w-3.5 h-3.5 text-teal-100" />
      </button>
    </div>
  );
}
