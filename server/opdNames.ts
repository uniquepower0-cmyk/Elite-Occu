/**
 * Editable hospital physician short-name dictionaries (Arabic & English)
 * plus deterministic fallback rules for new/unlisted physicians.
 */

export const KNOWN_AR_SHORT_NAMES: Record<string, string> = {
  'ولاء محمد الامير': 'ولاء الامير',
  'ولاء محمد محمود الامير': 'ولاء الامير',
  'عالية عبد الرحمن عبد الرحمن القراقصى': 'علياء القراقصي',
  'رانيا محمد عبده': 'رانيا عبده',
  'رانيا نبيل عبده': 'رانيا عبده',
  'الاء ممدوح': 'الاء ممدوح',
  'أمير حسن المغربي': 'أمير المغربي',
  'احمد شوقي محمد مرعي': 'احمد مرعي',
  'غاده الصياد': 'غاده الصياد',
  'رانيا حداد': 'رانيا الحداد',
  'احمد محمد مبروك الحوفي': 'احمد الحوفي',
  'نهاد محمد مصطفي المفتى': 'نهاد المفتي',
  'محمد القزق': 'محمد القزق',
  'عمر جمال العطار': 'عمر العطار',
  'علي احمد علي امام حسين': 'علي امام',
  'مها عبدالعزيز السيد الصغير': 'مها الصغير',
  'احمد عماد الدين عبد الرحمن خليفه': 'احمد خليفة',
  'زينب الباز': 'زينب الباز',
  'عمرو محمد عادل عبدالرحمن غنيم': 'عمرو غنيم',
  'محمد نافع': 'محمد نافع',
  'رضا فوزي': 'رضا فوزي',
  'شادي محمد المصيلحي احمد': 'شادي مصيلحي',
  'صلاح الجوهري': 'صلاح الجوهري',
  'ياسر حمزه': 'ياسر حمزة',
  'نبيل شحاته': 'نبيل شحاتة',
  'احمد فاروق القرموطي': 'أحمد القرموطي',
  'كريم رؤوف محمود سلام': 'كريم سلام',
  'عبدالرحمن نعيم عبدالقادر عبدالله نعيم': 'عبدالرحمن نعيم',
  'نديم بيومي': 'نديم بيومي',
  'احمد حمدي محمد حمدي متولي': 'احمد حمدي',
  'طارق عويس': 'طارق عويس',
  'محمد الصباغ': 'محمد الصباغ',
  'سهيل محمد ايمن فخري': 'سهيل فخرى',
  'أحمد موسى': 'احمد موسي',
  'جون نعيم أبراهيم فرج': 'جون نعيم',
  'احمد عبدالرحمن فتحي منصور': 'احمد فتحي',
  'داليا ابراهيم حلوج': 'داليا حلوج',
  'باسم حسن عبدالحليم حماد': 'باسم حماد',
  'محمود محمد البكري زمزم': 'محمود زمزم',
  'محمود شحاتة': 'محمود شحاته',
  'احمد سعيد طه موسى': 'احمد سعيد طه',
  'محمود محمد محمد ناضر': 'محمود ناضر',
  'دينا محمد يسري': 'دينا يسري',
  'شريف حبيبه': 'شريف حبيبة',
  'روبيرت صبحي بشري جورج': 'روبرت صبحي',
  'احمد محمود علي داود': 'احمد داوود',
  'عمرو علوانى': 'عمرو علواني',
  'حسن سعيد حسن هبيله': 'حسن هبيلة',
  'مختار ممدوح احمد عبد اللطيف': 'مختار عبداللطيف',
  'احمد عبد العزيز': 'احمد عبد العزيز',
  'عياده رسم المخ': 'رسم المخ',
  'ايمان رمضان محمد منصور': 'ايمان رمضان',
  'ساره سلامة': 'سارة سلامة',
  'محمد بيومي': 'محمد بيومي',
  'سلوى طارق خليل محمد': 'سلوى طارق',
  'كامل البطاط': 'كامل البطاط',
  'محمد احمد محمد عبدالمنعم': 'محمد عبدالمنعم',
  'محمد جمال توفيق حسن': 'محمد جمال توفيق',
  'احمد عبدالرحمن عبدالرحمن': 'احمد عبد الرحمن',
  'ناني حسن': 'ناني حسن',
  'ايمان سعد احمد ابو شطا': 'ايمان ابو شطا',
  'مصطفى عبدالجواد حمزه دعبيس': 'مصطفى دعبيس',
  'عمر احمد اسامه ابراهيم': 'عمر اسامه',
  'محمد حسن حسين زيتون': 'محمد زيتون',
  'مها محمد خيري الكومي': 'مها الكومي',
  'نعمات السيد السيد حجازي': 'نعمات حجازى',
  'هشام احمد جاب الله الغزالى': 'هشام الغزالي',
  'زياد محمد عبدالعزيز حسين': 'زياد عبد العزيز',
  'محمد عبد العزيز': 'محمد عبد العزيز',
  'خالد رزق السيد ابو العينين': 'خالد رزق',
  'بسام صقر': 'بسام صقر',
  'يحيى بدير': 'يحيي بدير',
  'ابراهيم الدالي': 'ابراهيم الدالي',
  'مينا ادور يوسف سلامه ادور': 'مينا ادوارد',
  'مصطفى نبيل': 'مصطفى نبيل',
  'خالد طه': 'خالد طه',
  'احمد محمد محمود جمعة': 'احمد جمعه',
  'محمد ابو السعود': 'محمد ابو السعود',
  'محمد سمير عبدالظاهر': 'محمد سمير',
  'طارق مرعي': 'طارق مرعي',
  'محمد طارق': 'محمد طارق',
  'عمرو محمد صبري': 'عمرو صبري',
  'بيشوى ناجى فرج جرجس': 'بيشوي',
  'شريف زيدان': 'شريف زيدان',
};

export const KNOWN_EN_SHORT_NAMES: Record<string, string> = {
  'عالية عبد الرحمن عبد الرحمن القراقصى': 'Alia Elkaraksy',
  'ولاء محمد الامير': 'Walaa elamir',
  'رانيا محمد عبده': 'Rania Abdo',
  'الاء ممدوح': 'Alaa Mamdouh',
  'أمير حسن المغربي': 'Amir ElMaghraby',
  'احمد شوقي محمد مرعي': 'Ahmed Marei',
  'غاده الصياد': 'Ghada ElSayad',
  'رانيا حداد': 'Rania ElHadad',
  'احمد محمد مبروك الحوفي': 'Ahmed ElHofy',
  'نهاد محمد مصطفي المفتى': 'Nehad ElMofty',
  'محمد القزق': 'Moh. ElKazak',
  'عمر جمال العطار': 'Omar El-Attar',
  'علي احمد علي امام حسين': 'Ali Emam',
  'مها عبدالعزيز السيد الصغير': 'Maha ElSagheir',
  'احمد عماد الدين عبد الرحمن خليفه': 'Ahmed khalifa',
  'زينب الباز': 'zinab ElBaz',
  'عمرو محمد عادل عبدالرحمن غنيم': 'Amr Ghoniem',
  'محمد نافع': 'Mohamed Nafea',
  'رضا فوزي': 'Reda Fawzy',
  'شادي محمد المصيلحي احمد': 'Shady elmoselhy',
  'صلاح الجوهري': 'Salah ElGohary',
  'ياسر حمزه': 'Yasser Hamza',
  'نبيل شحاته': 'Nabil Shehata',
  'احمد فاروق القرموطي': 'Ahmed ElKarmoty',
  'كريم رؤوف محمود سلام': 'kareem sallam',
  'عبدالرحمن نعيم عبدالقادر عبدالله نعيم': 'Abdelrahman Naeaam',
  'نديم بيومي': 'Nadeem Bayoumi',
  'احمد حمدي محمد حمدي متولي': 'Ahmed hamdy',
  'طارق عويس': 'Tarek Ewies',
  'محمد الصباغ': 'Mohamed ElSabbagh',
  'سهيل محمد ايمن فخري': 'Sohiel Fakhry',
  'أحمد موسى': 'Ahmed Mousa',
  'جون نعيم أبراهيم فرج': 'jone naaem',
  'احمد عبدالرحمن فتحي منصور': 'Ahmed Fathy',
  'داليا ابراهيم حلوج': 'dalia halwag',
  'باسم حسن عبدالحليم حماد': 'Bassem Hassan',
  'محمود محمد البكري زمزم': 'Mamoud Zamzam',
  'محمود شحاتة': 'Mahmoud Shehata',
  'احمد سعيد طه موسى': 'ahmed taha',
  'محمود محمد محمد ناضر': 'Mahmoud Nader',
  'دينا محمد يسري': 'Dina Yousry',
  'شريف حبيبه': 'Sherif Habeba',
  'روبيرت صبحي بشري جورج': 'robert sobhy',
  'احمد محمود علي داود': 'ahmed dawood',
  'عمرو علوانى': 'Amr Elwany',
  'حسن سعيد حسن هبيله': 'Hassan Habila',
  'مختار ممدوح احمد عبد اللطيف': 'Mokhtar Abdellatif',
  'احمد عبد العزيز': 'Ahmed AbdElAziz',
  'عياده رسم المخ': 'EEG',
  'ايمان رمضان محمد منصور': 'Eman ramadan',
  'ساره سلامة': 'sara salama',
  'محمد بيومي': 'Mohamed Bayomi',
  'سلوى طارق خليل محمد': 'Salwa Tarek',
  'كامل البطاط': 'Kamel ElBatat',
  'محمد احمد محمد عبدالمنعم': 'Moh. AbdElMoneim',
  'محمد جمال توفيق حسن': 'Mohamed Tawfiq',
  'احمد عبدالرحمن عبدالرحمن': 'Ahmed AbdElRahman',
  'ناني حسن': 'Nany Hassan',
  'ايمان سعد احمد ابو شطا': 'Eman AboShata',
  'مصطفى عبدالجواد حمزه دعبيس': 'mostafa deabis',
  'عمر احمد اسامه ابراهيم': 'Omar Osama',
  'محمد حسن حسين زيتون': 'Mohamed Zaiton',
  'مها محمد خيري الكومي': 'Maha ElKomy',
  'نعمات السيد السيد حجازي': 'Neamaat Hegazy',
  'هشام احمد جاب الله الغزالى': 'Hesham ElGhazaly',
  'زياد محمد عبدالعزيز حسين': 'Ziad abdelaziz',
  'محمد عبد العزيز': 'Mohamed AbdElAziz',
  'خالد رزق السيد ابو العينين': 'khaled rezk',
  'بسام صقر': 'Bassam Sakr',
  'يحيى بدير': 'Yehia Bedair',
  'ابراهيم الدالي': 'ebrahim eldaly',
  'مينا ادور يوسف سلامه ادور': 'mina edward',
  'مصطفى نبيل': 'Mostafa Nabil',
  'خالد طه': 'Khaled Taha',
  'احمد محمد محمود جمعة': 'Ahmed Gomaa',
  'محمد ابو السعود': 'Moh. AboElSoud',
  'محمد سمير عبدالظاهر': 'm.samir',
  'طارق مرعي': 'Tarek Marey',
  'محمد طارق': 'Mohamed tarek',
  'عمرو محمد صبري': 'Amr Sabry',
  'بيشوى ناجى فرج جرجس': 'Beshoy',
  'شريف زيدان': 'Sherif Zeidan',
  // Thursday & additional hospital physicians
  'احمد سمير محمد محمود زعربان': 'Ahmed Zaaraban',
  'فهمي عزت فهمي سعد': 'Fahmy Ezzat',
  'ميرا ياسر محمد السمنى': 'Mira Yasser',
  'مهند مجدي': 'Mohannad Magdy',
  'والى محفوظ': 'Waly Mahfouz',
  'أحمد ربيع': 'Ahmed Rabea',
  'احمد علاء الدين عبد الكريم مرعي': 'Ahmed Marei',
  'ايمان عبدالبديع': 'Eman Abdelbadea',
  'هنادي محمد حجازي محمد': 'Hanady Hegazy',
  'هبه عبداللطيف': 'Heba Abdellatief',
  'مي محمد مرسي حسين': 'Mai Hussein',
  'مياده عبد السلام الشريف': 'Mayada El Sheref',
  'ميرفت ابوالمعاطي': 'Mervat AboElmaty',
  'محمد المهدى': 'Mohamed El Mahdy',
  'شيماء محمد محمد شعبان': 'Shimaa Mohammed',
  'احمد حنفي محمد المصري': 'Ahmed El Masry',
  'احمد رمضان محسب ابوبكر': 'Ahmed Ramadan',
  'جمال الدين الغريانى': 'Gamal ElGheriany',
  'هند خميس محمد العكر': 'Hend Khamis',
  'مؤمن محمد مرسي حسين': "Mo'men Morsy",
  'نسرين علي': 'Nisreen Ali',
  'عمر رضا عبد الحميد رضا': 'Omar Reda',
  'اشرف الامين': 'Ashraf ElAmin',
  'نسمة محمد سعد جنيدي': 'Nesma Genedy',
  'اسامة محمود عبدالباقي المراغي': 'Osama ElMaraghi',
  'سوسن عادل عوض ابراهيم': 'Sawsan Adel',
  'منار عزت': 'Manar Ezzat',
  'محمد هلال': 'M. Halal',
  'بسنت سمير عبدالعظيم عبدالحميد': 'Passant Samir',
  'احمد رأفت محمود عبد العزيز النجار': 'Ahmed Rafaat',
  'اسلام محمد عبدالحمبد ماضي': 'Eslam Mady',
  'محمد سمير': 'Mohamed Samir',
  'وسام زكريا مسعود عمراوي': 'Wissam ElAmrawy',
  'احمد علاء محمد عبدالعزيز حسن صالح': 'Ahmed Alaa',
  'عبدالرحمن محمد احمد الجوهري': 'Abdelrahman ElGohary',
  'محمد جمال الجزار': 'Mohamed ElGazzar',
  'مصطفى حافظ محمد حافظ': 'Mostafa Hafez',
  'عبد الرحمن ثابت': 'Abdelrahman Thabet',
  'اماني منصور السيد منصور محمد': 'Amany Mansour',
  'احمد محمد ابو كيلة': 'Ahmed AboKela',
  'حسام محمد صلاح الدين الصباغ': 'Hossam ElSabbagh',
  'محمود درباله': 'Mahmoud Derbala',
  'محمد خالد محمد خالد': 'Mohamed Khaled',
  'شريف حجازى': 'Sherif Hegazy',
  'الهام ابو بكر الكردى': 'Elham ElKordy',
  'حسام ابو الخير': 'Hossam AboElKher',
  'محمد مدحت السبكي': 'ElSobky',
  'سالي عادل': 'Sally Adel',
};

function normAr(s: string): string {
  return s.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').trim();
}

const NORMALIZED_AR_MAP = new Map<string, string>(
  Object.entries(KNOWN_AR_SHORT_NAMES).map(([k, v]) => [normAr(k), v])
);

const NORMALIZED_EN_MAP = new Map<string, string>(
  Object.entries(KNOWN_EN_SHORT_NAMES).map(([k, v]) => [normAr(k), v])
);

function tokenizeArabicName(fullAr: string): string[] {
  const raw = String(fullAr || '').trim().replace(/\s+/g, ' ');
  if (!raw) return [];
  const words = raw.split(' ');
  const tokens: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if ((w === 'عبد' || w === 'أبو' || w === 'ابو') && i + 1 < words.length) {
      tokens.push(`${w} ${words[i + 1]}`);
      i += 2;
    } else if (
      i + 1 < words.length &&
      words[i + 1] === 'الدين' &&
      ['صلاح', 'سيف', 'علاء', 'نور', 'حسام', 'بهاء', 'محيي', 'محي', 'شمس', 'جمال', 'كمال', 'عماد'].includes(w)
    ) {
      tokens.push(w);
      i += 2;
    } else {
      tokens.push(w);
      i += 1;
    }
  }
  return tokens;
}

export function getShortArabicDoctorName(item: { physicianAr?: string; physicianEn?: string }): string {
  const raw = String(item.physicianAr || '').trim().replace(/\s+/g, ' ');
  if (!raw) return String(item.physicianEn || '').trim();
  if (raw.includes('رسم المخ')) return 'رسم المخ';
  if (KNOWN_AR_SHORT_NAMES[raw]) return KNOWN_AR_SHORT_NAMES[raw];

  const mapped = NORMALIZED_AR_MAP.get(normAr(raw));
  if (mapped) return mapped;

  const tokens = tokenizeArabicName(raw);
  if (tokens.length <= 2) return tokens.join(' ');
  const first = tokens[0];
  const second = tokens[1];
  const last = tokens[tokens.length - 1];
  const genericPatronymics = new Set([
    'الرحمن',
    'العزيز',
    'اللطيف',
    'المنعم',
    'العينين',
    'العنين',
    'السيد',
    'الحميد',
    'الجواد',
    'فتاح',
    'الفتاح',
  ]);
  if (last.startsWith('ال') && !genericPatronymics.has(normAr(last))) {
    return `${first} ${last}`;
  }
  return `${first} ${second}`;
}

const GENERIC_EN_PATRONYMICS = new Set([
  'mohamed',
  'mohammed',
  'ahmed',
  'mahmoud',
  'hussein',
  'hussien',
  'hassan',
  'ebrahim',
  'ibrahim',
  'ali',
  'saad',
  'salah',
  'abdelhamed',
  'abdelhamid',
  'aboubakr',
  'abobakr',
  'elsayed',
  'sayed',
  'mansour',
  'mostafa',
  'moustafa',
]);

function tokenizeEnglishName(fullEn: string): string[] {
  // Strip stray trailing/standalone punctuation (e.g. "Mohamed Gamal Elgazzar .")
  const cleaned = String(fullEn || '')
    .replace(/[.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const words = cleaned.split(' ').filter(Boolean);
  const tokens: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const wl = w.toLowerCase();
    if (
      (wl === 'el' || wl === 'al' || wl === 'abo' || wl === 'abou' || wl === 'abd' || wl === 'abdel') &&
      i + 1 < words.length
    ) {
      const next = words[i + 1];
      const nextL = next.toLowerCase();
      if ((wl === 'abo' || wl === 'abou' || wl === 'abd' || wl === 'abdel') && (nextL === 'el' || nextL === 'al') && i + 2 < words.length) {
        tokens.push(`${w}${next}${words[i + 2]}`);
        i += 3;
      } else {
        tokens.push(`${w}${next}`);
        i += 2;
      }
    } else if (i + 1 < words.length && words[i + 1].toLowerCase() === 'eldin') {
      tokens.push(w);
      i += 2;
    } else {
      tokens.push(w);
      i += 1;
    }
  }
  return tokens;
}

export function getShortEnglishDoctorName(item: { physicianAr?: string; physicianEn?: string }): string {
  const ar = String(item.physicianAr || '').trim().replace(/\s+/g, ' ');
  const en = String(item.physicianEn || '').trim().replace(/\s+/g, ' ');
  if (ar.includes('رسم المخ') || en.toLowerCase().includes('eeg')) return 'EEG';
  if (KNOWN_EN_SHORT_NAMES[ar]) return KNOWN_EN_SHORT_NAMES[ar];

  const mapped = NORMALIZED_EN_MAP.get(normAr(ar));
  if (mapped) return mapped;

  if (!en) return getShortArabicDoctorName(item);
  const tokens = tokenizeEnglishName(en);
  if (tokens.length <= 2) return tokens.join(' ');
  const first = tokens[0];
  const second = tokens[1];
  const last = tokens[tokens.length - 1];
  if (GENERIC_EN_PATRONYMICS.has(last.toLowerCase())) {
    return `${first} ${second}`;
  }
  return `${first} ${last}`;
}
