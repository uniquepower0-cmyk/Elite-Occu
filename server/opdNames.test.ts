import { describe, it, expect } from 'vitest';
import { getShortArabicDoctorName, getShortEnglishDoctorName } from './opdNames.js';

describe('opdNames', () => {
  it('maps known hospital Arabic HIS names to exact Elite PDF short display names', () => {
    const cases: Array<[string, string]> = [
      ['ولاء محمد الامير', 'ولاء الامير'],
      ['عالية عبد الرحمن عبد الرحمن القراقصى', 'علياء القراقصي'],
      ['خالد رزق السيد ابو العينين', 'خالد رزق'],
      ['عياده رسم المخ', 'رسم المخ'],
      ['شادي محمد المصيلحي احمد', 'شادي مصيلحي'],
      ['عمرو محمد عادل عبدالرحمن غنيم', 'عمرو غنيم'],
      ['بيشوى ناجى فرج جرجس', 'بيشوي'],
      ['محمد جمال توفيق حسن', 'محمد جمال توفيق'],
      ['احمد سعيد طه موسى', 'احمد سعيد طه'],
      ['عبدالرحمن نعيم عبدالقادر عبدالله نعيم', 'عبدالرحمن نعيم'],
    ];
    for (const [raw, expected] of cases) {
      expect(getShortArabicDoctorName({ physicianAr: raw, physicianEn: '' })).toBe(expected);
    }
  });

  it('maps known hospital English HIS names to clean Housing display names', () => {
    expect(getShortEnglishDoctorName({ physicianAr: 'عياده رسم المخ', physicianEn: 'EEG Clinic' })).toBe('EEG');
    expect(
      getShortEnglishDoctorName({
        physicianAr: 'عالية عبد الرحمن عبد الرحمن القراقصى',
        physicianEn: 'Alia Abdelrahman Abdelrahman El-karaksy',
      })
    ).toBe('Alia Elkaraksy');
    expect(
      getShortEnglishDoctorName({
        physicianAr: 'خالد رزق السيد ابو العينين',
        physicianEn: 'khaled Rezk Elsayed Abo elenin',
      })
    ).toBe('khaled rezk');
  });

  it('falls back cleanly for unknown new Arabic and English doctor names', () => {
    expect(
      getShortArabicDoctorName({
        physicianAr: 'طارق محمود حسن الشافعي',
        physicianEn: 'Tarek Mahmoud Hassan Elshafey',
      })
    ).toBe('طارق الشافعي');

    expect(
      getShortArabicDoctorName({
        physicianAr: 'يوسف عبد الرحمن محمد علي',
        physicianEn: 'Youssef Abdelrahman Mohamed Ali',
      })
    ).toBe('يوسف عبد الرحمن');

    expect(
      getShortEnglishDoctorName({
        physicianAr: 'طارق محمود حسن الشافعي',
        physicianEn: 'Tarek Mahmoud Hassan Elshafey',
      })
    ).toBe('Tarek Elshafey');

    // Trailing punctuation and compound prefixes / generic patronymics
    expect(
      getShortEnglishDoctorName({
        physicianAr: 'غير مسجل',
        physicianEn: 'Mohamed Gamal Elgazzar .',
      })
    ).toBe('Mohamed Elgazzar');

    expect(
      getShortEnglishDoctorName({
        physicianAr: 'غير مسجل',
        physicianEn: 'Hossam Abo el Kher',
      })
    ).toBe('Hossam AboelKher');

    expect(
      getShortEnglishDoctorName({
        physicianAr: 'غير مسجل',
        physicianEn: 'Amany Mansour Elsayed Mohamed',
      })
    ).toBe('Amany Mansour');
  });
});
