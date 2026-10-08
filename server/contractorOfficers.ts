/**
 * Contractor Officer Matching & Sheet Date Formatting Engine
 *
 * Maps contractors to the designated contracting officers based on the official hospital matrix:
 * - طارق (+20 11 48404831)
 * - حمزة (+20 12 29396879)
 * - جابر (+20 12 04543250)
 * - ديانا (+20 12 84460038)
 * - ابو الوفا (+20 12 08477032)
 * - نادين (+20 15 57666514)
 * - زياد (+20 12 07544537)
 */

export interface OfficerInfo {
  name: string;
  phone: string;
}

export const OFFICERS: Record<string, OfficerInfo> = {
  tareq: { name: 'طارق', phone: '+20 11 48404831' },
  hamza: { name: 'حمزة', phone: '+20 12 29396879' },
  gaber: { name: 'جابر', phone: '+20 12 04543250' },
  diana: { name: 'ديانا', phone: '+20 12 84460038' },
  abu_el_wafa: { name: 'ابو الوفا', phone: '+20 12 08477032' },
  nadine: { name: 'نادين', phone: '+20 15 57666514' },
  ziad: { name: 'زياد', phone: '+20 12 07544537' },
  patient_accounts: { name: 'حسابات المرضى', phone: '' },
};

export const CASH_OFFICER_NAME = 'حسابات المرضى';

/**
 * Normalizes text for robust Arabic & Latin search matching
 */
export function normalizeContractorText(text: any): string {
  if (text === undefined || text === null) return '';
  let t = String(text).toLowerCase();
  // Arabic letter normalization
  t = t.replace(/[أإآا]/g, 'ا');
  t = t.replace(/[ة]/g, 'ه');
  t = t.replace(/[ى]/g, 'ي');
  // Remove punctuation and noise characters
  t = t.replace(/[\(\)\[\]\-\_\.\,\/\+\:\*\#\–\—]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Sanitizes contractor names for sheet display by removing noise words:
 * - Removes the English word "main" (case-insensitive)
 * - Removes Arabic "شركة" and "شركه"
 */
export function cleanContractorForDisplay(text: any): string {
  if (text === undefined || text === null) return '';
  let s = String(text).trim();
  if (!s || s === '-' || s === 'null' || s === 'undefined') return '';

  // Remove "main" (case-insensitive whole word)
  s = s.replace(/\bmain\b/gi, '');

  // Remove "شركة" and "شركه"
  s = s.replace(/(^|[\s\(\[\-\_\/\.\,\:\*\#])(شركة|شركه)([\s\)\]\-\_\/\.\,\:\*\#]|$)/g, '$1 $3');
  s = s.replace(/(شركة|شركه)/g, '');

  // Clean empty parentheses, brackets, duplicate spaces
  s = s.replace(/\(\s*\)/g, '');
  s = s.replace(/\[\s*\]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Detects if a contractor string or financial status represents a cash / self-paying patient
 */
export function isCashContractor(text: any): boolean {
  if (text === undefined || text === null) return false;
  const raw = String(text).trim();
  if (!raw || raw === '-' || raw === 'null' || raw === 'undefined') return false;

  const norm = normalizeContractorText(raw);
  if (!norm) return false;

  // Direct cash words anywhere in string (e.g. "نقابة اطباء Cash", "خصم نادي سبورتنج كاش", "Home Care - Cash", "كاش", "نقدي")
  if (
    norm.includes('cash') ||
    norm.includes('كاش') ||
    norm.includes('نقدي') ||
    norm.includes('نقدى') ||
    /\bنقد\b/.test(norm) ||
    norm.includes('حسابات المرضى') ||
    norm.includes('حسابات مرضي')
  ) {
    return true;
  }

  // Generic self-paying / individuals terms
  if (
    norm === 'individuals' ||
    norm === 'self' ||
    norm === 'افراد' ||
    norm === 'أفراد' ||
    norm === 'شخصي' ||
    norm === 'شخصى' ||
    norm === 'عميل' ||
    norm === 'بدون جهة' ||
    norm === 'بدون جهه' ||
    norm === 'عقد الرياض el rayad' ||
    norm === 'contractorname'
  ) {
    return true;
  }

  return false;
}

/**
 * Determines the designated contracting officer ("مسئول التعاقد") for a given contractor name.
 * For all cash / self-paying patients, returns "حسابات المرضى".
 */
export function getResponsibleOfficer(contractor: string | null | undefined, financialStatus?: string | null | undefined): string {
  // If financial status explicitly indicates cash, officer is always Patient Accounts
  if (financialStatus && isCashContractor(financialStatus)) {
    return CASH_OFFICER_NAME;
  }

  if (!contractor) return '-';
  const raw = String(contractor).trim();
  if (!raw || raw === '-' || raw === 'null' || raw === 'undefined') return '-';

  const norm = normalizeContractorText(raw);
  if (!norm) return '-';

  // Any cash patient / self-paying / generic values are handled by Patient Accounts ("حسابات المرضى")
  if (isCashContractor(norm)) {
    return CASH_OFFICER_NAME;
  }

  // 1. High-priority exact brand disambiguations

  // EPROM (جابر) - e.g. '(EPROM) ايبروم ايلاب و مجمع', 'ايبروم ميدور'
  if (/\beprom\b|ايبروم/.test(norm)) {
    return OFFICERS.gaber.name;
  }

  // ابوقير للأسمدة (طارق) vs بترول ابوقير (نادين)
  if (norm.includes('ابوقير') || norm.includes('ابو قير')) {
    if (norm.includes('سماد') || norm.includes('اسمد')) {
      return OFFICERS.tareq.name;
    }
    if (norm.includes('بترول')) {
      return OFFICERS.nadine.name;
    }
    return OFFICERS.tareq.name;
  }

  // مياه شرب الاسكندرية (زياد) vs اسكندرية للبترول (جابر)
  if (norm.includes('اسكندري') || norm.includes('alex')) {
    if (['مياه', 'شرب', 'ماء', 'water'].some(w => norm.includes(w))) {
      return OFFICERS.ziad.name;
    }
    if (['بترول', 'تكرير', 'petroleum'].some(w => norm.includes(w))) {
      return OFFICERS.gaber.name;
    }
  }

  // اسمنت العامرية (نادين) vs العامرية للبترول (جابر)
  if (norm.includes('عامري') || norm.includes('amrey') || norm.includes('amriy')) {
    if (norm.includes('اسمنت') || norm.includes('cement')) {
      return OFFICERS.nadine.name;
    }
    if (norm.includes('بترول') || norm.includes('تكرير')) {
      return OFFICERS.gaber.name;
    }
  }

  // قناة السويس للتأمين (جابر) vs هيئة قناة السويس (حمزة) vs السويس للزيت سوكو (ابو الوفا) vs جابكو خليج السويس (جابر)
  if (norm.includes('جابكو') || norm.includes('gupco') || norm.includes('خليج السويس')) {
    return OFFICERS.gaber.name;
  }
  if (norm.includes('سوكو') || norm.includes('suco') || norm.includes('السويس للزيت')) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (norm.includes('سويس') || norm.includes('suez')) {
    if (norm.includes('تامين') || norm.includes('insurance')) {
      return OFFICERS.gaber.name;
    }
    if (norm.includes('هيئ') || norm.includes('هيه') || norm.includes('authority')) {
      return OFFICERS.hamza.name;
    }
    return OFFICERS.hamza.name;
  }

  // مشرق: دريم مشرق / مشرق لتنمية الأعمال (جابر) vs المشرق Mashreq (ديانا)
  if (norm.includes('مشرق') || norm.includes('mashreq')) {
    if (['دريم', 'اغذي', 'تنمي', 'اعمال', 'dream', 'food', 'business'].some(w => norm.includes(w))) {
      return OFFICERS.gaber.name;
    }
    return OFFICERS.diana.name;
  }

  // العامة للبترول (ابو الوفا) vs النقابة العامة للبترول (جابر)
  if (norm.includes('العامه للبترول') || norm.includes('العامة للبترول')) {
    if (norm.includes('نقاب')) {
      return OFFICERS.gaber.name;
    }
    return OFFICERS.abu_el_wafa.name;
  }

  // Sumed (ابو الوفا) vs يوني ميد (ابو الوفا) vs يوميد U-Med (جابر) vs يوني كير (ابو الوفا)
  if (/\bsumed\b|سوميد/.test(norm)) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (/\bunimed\b|يوني ميد|يونيميد/.test(norm)) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (/\b(u med|umed)\b|يوميد/.test(norm)) {
    return OFFICERS.gaber.name;
  }
  if (/\bunicare\b|يوني كير|يونيكير/.test(norm)) {
    return OFFICERS.abu_el_wafa.name;
  }

  // مصر: مصر للطيران (ابو الوفا) / عناية مصر (زياد) / مصر للصيانة EMC (طارق) / مصر الخير (ابو الوفا) / مصر هيلث كير (ديانا)
  if (norm.includes('مصر للطيران') || norm.includes('egyptair') || norm.includes('شحن جوي') || norm.includes('خدمات ارضي')) {
    return OFFICERS.abu_el_wafa.name;
  }
  if ((norm.includes('عناي') && norm.includes('مصر')) || norm.includes('enaya')) {
    return OFFICERS.ziad.name;
  }
  if (norm.includes('صان مصر') || (norm.includes('مصر') && norm.includes('صيان')) || /\bemc\b/.test(norm)) {
    return OFFICERS.tareq.name;
  }
  if (norm.includes('مصر الخير')) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (norm.includes('مصر هيلث') || norm.includes('misr health')) {
    return OFFICERS.diana.name;
  }

  // وادي: وادي دجلة (نادين) / جنوب الوادي (نادين) / وادي النيل (حمزة)
  if (norm.includes('دجل') || norm.includes('degla')) {
    return OFFICERS.nadine.name;
  }
  if (norm.includes('جنوب الوادي') || norm.includes('جنوب الوادى') || norm.includes('ganope')) {
    return OFFICERS.nadine.name;
  }
  if (norm.includes('وادي النيل') || norm.includes('وادى النيل') || norm.includes('wadi el nile')) {
    return OFFICERS.hamza.name;
  }

  // المحاسبات (جابر) vs البنك المركزي المصري (ابو الوفا)
  if (norm.includes('محاسب') || norm.includes('auditing')) {
    return OFFICERS.gaber.name;
  }
  if ((norm.includes('بنك') || norm.includes('bank')) && norm.includes('مركزي')) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (norm.includes('مركزي مصري') || norm.includes('مركزي المصر')) {
    return OFFICERS.abu_el_wafa.name;
  }

  // الرقابة الادارية (طارق)
  if ((norm.includes('رقاب') && norm.includes('ادار')) || norm.includes('administrative control')) {
    return OFFICERS.tareq.name;
  }

  // المصرف العربي (طارق)
  if ((norm.includes('مصرف') && norm.includes('عربي')) || norm.includes('arab african')) {
    return OFFICERS.tareq.name;
  }

  // مجلس الدفاع الوطني (ابو الوفا) vs مجلس النواب (ديانا)
  if (norm.includes('دفاع') && norm.includes('وطن')) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (norm.includes('نواب') || norm.includes('برلمان')) {
    return OFFICERS.diana.name;
  }

  // النقابات
  if (norm.includes('زراع')) {
    return OFFICERS.abu_el_wafa.name;
  }
  if (norm.includes('مهندس') || norm.includes('engineers')) {
    return OFFICERS.diana.name;
  }
  if (norm.includes('طبيب') || norm.includes('اطباء') || norm.includes('doctors')) {
    return OFFICERS.diana.name;
  }
  if (norm.includes('محاكم') || norm.includes('محاكمة')) {
    return OFFICERS.diana.name;
  }
  if (norm.includes('نقاب') && norm.includes('بترول')) {
    return OFFICERS.gaber.name;
  }

  // --- ZIAD (زياد) ---
  if (['جلوب ميد', 'جلوبميد', 'globemed'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['جاسكو', 'gasco', 'gasko'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['بترومنت', 'بترومينت', 'petromaint'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['الصحراء الغربي', 'wepco', 'ويبكو'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['سموح', 'smouha'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['فاركو', 'pharco'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['ايجي كير', 'ايجى كير', 'egycare', 'egy care'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['سوليتك', 'solitech'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['بروبلين', 'بروبيلين', 'epp'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['اوميجا كير', 'أوميجا كير', 'omega care', 'omegacare'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['ايجي ميد', 'ايجى ميد', 'egymed', 'egy med'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['حياه كارد', 'حياة كارد', 'hayat card'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (['بتروسنان', 'petrosannan'].some(k => norm.includes(k))) return OFFICERS.ziad.name;
  if (norm.includes('جياد')) return OFFICERS.ziad.name;
  if (/\bgig\b|جي اي جي/.test(norm)) return OFFICERS.ziad.name;
  if (['بورتلاند', 'portland'].some(k => norm.includes(k))) return OFFICERS.ziad.name;

  // --- NADINE (نادين) ---
  if (['ميد رايت', 'ميدرايت', 'med right', 'medright'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['اثيدكو', 'ايثيدكو', 'ethydco'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['سيدبك', 'سيدي كرير', 'سيدى كرير', 'sidpec'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['وتك', 'wotech'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['بنك فيصل', 'فيصل الاسلامي', 'faisal'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['الحمرا اويل', 'الحمراء اويل', 'hamra oil'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['سبورتنج', 'sporting'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['بلاعيم', 'petrobel'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['عجيب', 'agiba'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['لايف هيلث', 'life health'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['انبي', 'enppi'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['بترو امير', 'بتروامير', 'petro amir'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['بيريللي', 'بيريللى', 'pirelli', 'بريميتيون', 'prometeon'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['بتروفرح', 'petrofarah', 'petro farah'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['جنوب الضبع', 'south dabaa'].some(k => norm.includes(k))) return OFFICERS.nadine.name;
  if (['معاك', 'ma3ak'].some(k => norm.includes(k))) return OFFICERS.nadine.name;

  // --- ABU EL WAFA (ابو الوفا) ---
  if (['اليكو', 'alico', 'metlife alico'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (norm.includes('التعاون للبترول')) return OFFICERS.abu_el_wafa.name;
  if (['خالد', 'khalda'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (['منصور', 'mansour'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (['سادات', 'sadat'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (['دمنهور', 'damanhour'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (['بتروجلف', 'petrogulf'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (['دستوري', 'constitutional'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;
  if (['بدر الدين', 'bapetco', 'بابيتكو'].some(k => norm.includes(k))) return OFFICERS.abu_el_wafa.name;

  // --- DIANA (ديانا) ---
  if (['عدل', 'justice'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['عز', 'الدخيل', 'ezz'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['ميدنت', 'ميد نت', 'mednet'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['كير بلاس', 'كيربلس', 'care plus', 'careplus'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['ليمتلس', 'limitless'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['ايلاب', 'elab'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['ميدمارك', 'ميد مارك', 'medmark'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['صيد', 'shooting club'].some(k => norm.includes(k))) return OFFICERS.diana.name;
  if (['كينج مريوط', 'معاهد الكينج', 'كينج'].some(k => norm.includes(k))) return OFFICERS.diana.name;

  // --- GABER (جابر) ---
  if (['صحه وان', 'صحة وان', 'seha one', 'seha 1'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['انابيب البترول', 'انابيب'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['ميدور', 'midor', 'الشرق الاوسط لتكرير'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['بتروتريد', 'petrotrade'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['غاز تك', 'غازتك', 'gastec'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['اكبا', 'اسبا', 'akpa'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['خدمات البترول البحري', 'pms'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['يونايتد', 'united'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['بترولوج', 'petrolog', 'pls'].some(k => norm.includes(k))) return OFFICERS.gaber.name;
  if (['ضرائب', 'tax'].some(k => norm.includes(k))) return OFFICERS.gaber.name;

  // --- HAMZA (حمزة) ---
  if (['نكست كير', 'نكستكير', 'next care', 'nextcare'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['اهلي', 'ahly'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['انريك', 'أنريك', 'انربك', 'anrpc', 'anrec'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['اموك', 'أموك', 'amoc'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['اكسون', 'إكسون', 'exxon'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['ماسي', 'dms', 'دي ام اس'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['موبكو', 'mopco'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['اون لاين', 'online', 'اكسكلوسيف', 'exclusive'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['شمال سيناء', 'نوسبكو', 'north sinai'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['elng', 'ادكو للغاز', 'غاز مسال'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['نايل سات', 'نايلسات', 'nilesat'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['اتحاد سكندري', 'نادي الاتحاد', 'نادى الاتحاد', 'الاتحاد'].some(k => norm.includes(k))) return OFFICERS.hamza.name;
  if (['اسبك', 'asppc'].some(k => norm.includes(k))) return OFFICERS.hamza.name;

  // --- TAREQ (طارق) ---
  if (/\bqnb\b|قطر الوطني/.test(norm)) return OFFICERS.tareq.name;
  if (['ثروه', 'ثروة', 'sarwa'].some(k => norm.includes(k))) return OFFICERS.tareq.name;
  if (['بتروكيماويات', 'petrochemicals'].some(k => norm.includes(k))) return OFFICERS.tareq.name;
  if (['مطروح', 'matrouh'].some(k => norm.includes(k))) return OFFICERS.tareq.name;
  if (/\baxa\b|اكسا/.test(norm)) return OFFICERS.tareq.name;

  return '-';
}

/**
 * Formats any date input strictly to DD/MM/YYYY without clock/time for downloadable Excel sheets.
 */
export function formatDateForSheet(val: any): string {
  if (val === undefined || val === null) return '';
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${d}/${m}/${y}`;
  }

  let s = String(val).trim();
  if (!s || s === '-' || s === 'null' || s === 'undefined') return '';

  // Convert Arabic numerals to Western digits
  s = s.replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);

  // Check 13-digit Unix ms timestamp
  if (/^\d{13}$/.test(s)) {
    const d = new Date(parseInt(s, 10));
    if (!isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
  }

  // Check 10-digit Unix second timestamp
  if (/^\d{10}$/.test(s)) {
    const d = new Date(parseInt(s, 10) * 1000);
    if (!isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
  }

  // Check Excel serial number (range ~2009 to 2063)
  const num = Number(s);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const d = new Date((num - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
  }

  // 1. Check DD-MM-YYYY or DD/MM/YYYY (with optional time component, e.g. "07-10-2026 14:30")
  const matchDMY = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+.*)?$/);
  if (matchDMY) {
    const d = String(parseInt(matchDMY[1], 10)).padStart(2, '0');
    const m = String(parseInt(matchDMY[2], 10)).padStart(2, '0');
    const y = matchDMY[3];
    return `${d}/${m}/${y}`;
  }

  // 2. Check ISO format YYYY-MM-DD or YYYY/MM/DD (with optional time component)
  const matchYMD = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[T\s].*)?$/);
  if (matchYMD) {
    const y = matchYMD[1];
    const m = String(parseInt(matchYMD[2], 10)).padStart(2, '0');
    const d = String(parseInt(matchYMD[3], 10)).padStart(2, '0');
    return `${d}/${m}/${y}`;
  }

  // 3. Fallback to standard JavaScript date parsing
  try {
    const dObj = new Date(s);
    if (!isNaN(dObj.getTime())) {
      const y = dObj.getFullYear();
      if (y >= 1990 && y <= 2090) {
        const m = String(dObj.getMonth() + 1).padStart(2, '0');
        const d = String(dObj.getDate()).padStart(2, '0');
        return `${d}/${m}/${y}`;
      }
    }
  } catch (_) {}

  return s;
}
