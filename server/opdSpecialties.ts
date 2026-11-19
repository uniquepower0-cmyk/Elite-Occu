import type { OPDClinicSession } from './opdLogic.js';
import { getShortArabicDoctorName } from './opdNames.js';

export interface OPDSpecialtyRowConfig {
  id: string;
  labelAr: string;
  maxPerRow: number;
  match: (s: OPDClinicSession) => boolean;
  subNote: (s: OPDClinicSession) => string;
}

function spLower(s: OPDClinicSession): string {
  return String(s.specialty || s.specialities || '').toLowerCase().trim();
}

/**
 * Exact 22 Elite Hospital specialty rows matching عيادات ايليت الاربعاء 18-11.pdf.pdf
 */
export const OPD_SPECIALTY_ROWS: OPDSpecialtyRowConfig[] = [
  {
    id: 'ent',
    labelAr: 'أنف و أذن و حنجرة\n(السنتر الرئيسي)',
    maxPerRow: 5,
    match: s => {
      const sp = spLower(s);
      return sp.includes('ent ') || sp === 'ent' || sp.includes('audiometry') || sp.includes('speech and swallowing');
    },
    subNote: s => {
      const sp = spLower(s);
      const shortAr = getShortArabicDoctorName(s);
      if (sp.includes('audiometry')) return '(سمعيات)';
      if (sp.includes('speech and swallowing') && !shortAr.includes('الاء ممدوح')) return '(صعوبه بلع وتخاطب)';
      return '';
    },
  },
  {
    id: 'peds',
    labelAr: 'أطفال\n(السنتر الرئيسي)',
    maxPerRow: 6,
    match: s => {
      const sp = spLower(s);
      return sp.startsWith('pediatrics') || sp.includes('neonatology') || sp.includes('pediatric nephrology');
    },
    subNote: () => '',
  },
  {
    id: 'pulm',
    labelAr: 'صدرية\n(السنتر الرئيسي)',
    maxPerRow: 6,
    match: s => spLower(s).includes('pulmonology') || spLower(s).includes('chest'),
    subNote: () => '',
  },
  {
    id: 'opth',
    labelAr: 'رمد (طب العيون)\n(السنتر الرئيسي)',
    maxPerRow: 6,
    match: s => spLower(s).includes('ophthalmology'),
    subNote: () => '',
  },
  {
    id: 'obgyn',
    labelAr: 'نسا و ولادة\n(سنتر الجراحة)',
    maxPerRow: 6,
    match: s => spLower(s).includes('obstetrics') || spLower(s).includes('gynecology'),
    subNote: () => '',
  },
  {
    id: 'gs',
    labelAr: 'جراحة عامة\n(سنتر الجراحة)',
    maxPerRow: 7,
    match: s => {
      const sp = spLower(s);
      const shortAr = getShortArabicDoctorName(s);
      if (
        sp.includes('general surgery') ||
        sp.includes('pediatric surgery') ||
        sp.includes('colorectal surgery') ||
        sp.includes('endocrine surgery') ||
        sp.includes('breast surgery') ||
        sp.includes('pediatric oncology surgery') ||
        sp.includes('surgical oncology')
      ) {
        return true;
      }
      if (shortAr.includes('نبيل شحاتة')) return true;
      if (sp.includes('bariatric surgery') && shortAr.includes('رضا فوزي')) return true;
      return false;
    },
    subNote: s => {
      const sp = spLower(s);
      const shortAr = getShortArabicDoctorName(s);
      if (sp.includes('pediatric surgery')) return '(جراحة أطفال)';
      if (sp.includes('bariatric surgery')) return '(جراحة سمنة)';
      if (sp.includes('colorectal')) return '(شرج وقولون)';
      if (sp.includes('endocrine surgery')) return '(جراحة غدد)';
      if (sp.includes('breast surgery')) return '(جراحة أورام الثدي)';
      if (sp.includes('surgical oncology')) return '(جراحة أورام)';
      return '';
    },
  },
  {
    id: 'vasc',
    labelAr: 'جراحة اوعية دموية\n(سنتر القلب)',
    maxPerRow: 6,
    match: s => spLower(s).includes('vascular surgery'),
    subNote: s => (getShortArabicDoctorName(s).includes('محمد الصباغ') ? '(جراحه اوعيه دمويه)' : ''),
  },
  {
    id: 'uro',
    labelAr: 'مسالك بولية وكلى\n(سنتر الجراحة)',
    maxPerRow: 6,
    match: s => {
      const sp = spLower(s);
      return sp.includes('urology') && !sp.includes('neurology');
    },
    subNote: () => '',
  },
  {
    id: 'derma',
    labelAr: 'جلدية وتجميل\n(سنتر الجراحة)',
    maxPerRow: 6,
    match: s => spLower(s).includes('dermatology'),
    subNote: () => '',
  },
  {
    id: 'plastic',
    labelAr: 'جراحة التجميل\n(سنتر الجراحة)',
    maxPerRow: 6,
    match: s => {
      const sp = spLower(s);
      const shortAr = getShortArabicDoctorName(s);
      return sp.includes('plastic surgery') && !shortAr.includes('نبيل شحاتة');
    },
    subNote: () => '',
  },
  {
    id: 'cardio',
    labelAr: 'القلب والاوعية\n(سنتر القلب)',
    maxPerRow: 6,
    match: s => spLower(s).includes('cardiology') || spLower(s).includes('echo'),
    subNote: () => '',
  },
  {
    id: 'ct_surg',
    labelAr: 'جراحة القلب والصدر\n(سنتر القلب)',
    maxPerRow: 6,
    match: s => spLower(s).includes('cardiothoracic'),
    subNote: () => '',
  },
  {
    id: 'neuro_surg',
    labelAr: 'جراحة المخ والاعصاب\n(سنتر المخ والاعصاب)',
    maxPerRow: 6,
    match: s => spLower(s).includes('neurosurgery') || spLower(s).includes('spine surgery'),
    subNote: () => '',
  },
  {
    id: 'neuro_psych',
    labelAr: 'نفسية وعصبية\n(سنتر المخ والاعصاب)',
    maxPerRow: 6,
    match: s => {
      const sp = spLower(s);
      return (
        sp.includes('neurology') ||
        sp.includes('neuropsychiatry') ||
        sp.includes('psychiatry') ||
        sp.includes('nerve conduction') ||
        sp.includes('eeg')
      );
    },
    subNote: s => (spLower(s).includes('nerve conduction') ? '(رسم عصب)' : ''),
  },
  {
    id: 'im',
    labelAr: 'الباطنة\n(سنتر الباطنة)',
    maxPerRow: 6,
    match: s => {
      const sp = spLower(s);
      return (
        sp.includes('internal medicine') ||
        sp.includes('nephrology') ||
        sp.includes('hematology') ||
        sp.includes('geriatrics') ||
        sp.includes('rheumatology') ||
        sp.includes('diabetes') ||
        sp.includes('endocrinology')
      );
    },
    subNote: s => {
      const sp = spLower(s);
      const shortAr = getShortArabicDoctorName(s);
      if (shortAr.includes('كامل البطاط')) return '(سنتر الرئيسي )';
      if (shortAr.includes('محمد عبدالمنعم')) return '(باطن عام وكلى )';
      if (shortAr.includes('ناني حسن') || sp.includes('geriatrics')) return '(باطنة عامة وشيخوخة)';
      if (sp.includes('hematology')) return '(امراض دم )';
      return '';
    },
  },
  {
    id: 'nutr',
    labelAr: 'تغذية علاجية\n(سنتر الباطنة)',
    maxPerRow: 6,
    match: s => spLower(s).includes('nutrition'),
    subNote: () => '',
  },
  {
    id: 'onc',
    labelAr: 'أورام باطنة\n(سنتر الباطنة)',
    maxPerRow: 6,
    match: s => {
      const sp = spLower(s);
      return (sp.includes('oncology') && !sp.includes('surgery'));
    },
    subNote: () => '',
  },
  {
    id: 'ortho',
    labelAr: 'جراحة العظام والمفاصل\n(سنتر العظام)',
    maxPerRow: 6,
    match: s => spLower(s).includes('orthopedic') || spLower(s).includes('bone tumor') || spLower(s).includes('arthroscopy'),
    subNote: s => {
      const shortAr = getShortArabicDoctorName(s);
      if (shortAr.includes('يحيي بدير') || shortAr.includes('يحيى بدير')) return '(كتف)';
      return '';
    },
  },
  {
    id: 'git',
    labelAr: 'جهاز هضمي ومناظير\n(سنتر المناظير)',
    maxPerRow: 6,
    match: s => spLower(s).includes('gastroenterology') || spLower(s).includes('hepatology') || spLower(s).includes('git'),
    subNote: s => (getShortArabicDoctorName(s).includes('خالد طه') ? '(باطنة جهاز هضمي)' : ''),
  },
  {
    id: 'dental',
    labelAr: 'جراحات الفم والاسنان\n(السنتر الرئيسي)',
    maxPerRow: 6,
    match: s => spLower(s).includes('dental') || spLower(s).includes('oral'),
    subNote: () => '',
  },
  {
    id: 'physio',
    labelAr: 'علاج طبيعي\n(سنتر العلاج الطبيعي)',
    maxPerRow: 6,
    match: s =>
      spLower(s).includes('physiotherpy') ||
      (spLower(s).includes('physiotherapy') && !spLower(s).includes('sessions')),
    subNote: () => '',
  },
  {
    id: 'endo_bari_surg',
    labelAr: 'جراحات الغدد الصماء والسمنه\n(سنتر الجراحة)',
    maxPerRow: 6,
    match: s => spLower(s).includes('endocrine surgery') || spLower(s).includes('bariatric surgery'),
    subNote: s => (spLower(s).includes('bariatric surgery') ? '(سنتر الباطنة)' : ''),
  },
];

export function mapSessionToSpecialtyRows(session: OPDClinicSession): OPDSpecialtyRowConfig[] {
  return OPD_SPECIALTY_ROWS.filter(cfg => cfg.match(session));
}
