// Pool of device fingerprints mimicking real Telegram clients across many device models.
// Each account gets a random fingerprint so sessions don't look identical to Telegram.

const DEVICE_POOL = [
  // Samsung Galaxy series
  { deviceModel: 'Samsung Galaxy S21', systemVersion: 'Android 12', appVersion: '9.3.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Samsung Galaxy S22 Ultra', systemVersion: 'Android 13', appVersion: '9.6.7', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Samsung Galaxy A52', systemVersion: 'Android 11', appVersion: '9.2.1', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'Samsung Galaxy A73 5G', systemVersion: 'Android 12', appVersion: '9.4.5', langCode: 'en', systemLangCode: 'en-IN' },
  { deviceModel: 'Samsung Galaxy M32', systemVersion: 'Android 11', appVersion: '9.1.8', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Samsung Galaxy S20 FE', systemVersion: 'Android 12', appVersion: '9.3.1', langCode: 'en', systemLangCode: 'en-AU' },
  { deviceModel: 'Samsung Galaxy Note 20', systemVersion: 'Android 12', appVersion: '9.3.5', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Samsung Galaxy A33', systemVersion: 'Android 12', appVersion: '9.3.2', langCode: 'en', systemLangCode: 'en-GB' },

  // Xiaomi series
  { deviceModel: 'Xiaomi Redmi Note 11', systemVersion: 'Android 12', appVersion: '9.3.1', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Xiaomi 12 Pro', systemVersion: 'Android 13', appVersion: '9.5.2', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Xiaomi Redmi 10C', systemVersion: 'Android 11', appVersion: '9.2.3', langCode: 'en', systemLangCode: 'en-IN' },
  { deviceModel: 'Xiaomi POCO X4 Pro', systemVersion: 'Android 12', appVersion: '9.4.1', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Xiaomi Redmi Note 10 Pro', systemVersion: 'Android 11', appVersion: '9.2.1', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'Xiaomi Mi 11 Lite', systemVersion: 'Android 11', appVersion: '9.1.9', langCode: 'en', systemLangCode: 'en-US' },

  // Huawei series
  { deviceModel: 'Huawei P30 Pro', systemVersion: 'Android 10', appVersion: '8.9.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Huawei Nova 9', systemVersion: 'Android 11', appVersion: '9.1.5', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'Huawei Y9 Prime 2019', systemVersion: 'Android 9', appVersion: '8.7.2', langCode: 'en', systemLangCode: 'en-US' },

  // OnePlus series
  { deviceModel: 'OnePlus 10 Pro', systemVersion: 'Android 13', appVersion: '9.6.2', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'OnePlus Nord 2', systemVersion: 'Android 12', appVersion: '9.3.4', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'OnePlus 9R', systemVersion: 'Android 11', appVersion: '9.2.2', langCode: 'en', systemLangCode: 'en-IN' },

  // Oppo series
  { deviceModel: 'OPPO Reno 8', systemVersion: 'Android 12', appVersion: '9.4.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'OPPO A57', systemVersion: 'Android 12', appVersion: '9.3.6', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'OPPO Find X5', systemVersion: 'Android 12', appVersion: '9.4.0', langCode: 'en', systemLangCode: 'en-GB' },

  // Realme series
  { deviceModel: 'Realme 9 Pro+', systemVersion: 'Android 12', appVersion: '9.3.8', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Realme GT 2 Pro', systemVersion: 'Android 12', appVersion: '9.4.4', langCode: 'en', systemLangCode: 'en-IN' },

  // Vivo series
  { deviceModel: 'vivo V25 Pro', systemVersion: 'Android 12', appVersion: '9.4.6', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'vivo Y35', systemVersion: 'Android 12', appVersion: '9.3.9', langCode: 'en', systemLangCode: 'en-US' },

  // Google Pixel series
  { deviceModel: 'Pixel 6', systemVersion: 'Android 13', appVersion: '9.5.4', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Pixel 7 Pro', systemVersion: 'Android 13', appVersion: '9.6.5', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Pixel 5', systemVersion: 'Android 12', appVersion: '9.3.0', langCode: 'en', systemLangCode: 'en-US' },

  // Motorola series
  { deviceModel: 'Motorola Edge 30', systemVersion: 'Android 12', appVersion: '9.4.2', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Motorola Moto G82', systemVersion: 'Android 12', appVersion: '9.3.7', langCode: 'en', systemLangCode: 'en-GB' },

  // iPhone series
  { deviceModel: 'iPhone 13 Pro Max', systemVersion: '15.6', appVersion: '9.3.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'iPhone 14 Pro', systemVersion: '16.2', appVersion: '9.6.0', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'iPhone 12', systemVersion: '15.4', appVersion: '9.2.8', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'iPhone SE (3rd gen)', systemVersion: '15.5', appVersion: '9.3.0', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'iPhone 11', systemVersion: '15.1', appVersion: '9.2.4', langCode: 'en', systemLangCode: 'en-AU' },
  { deviceModel: 'iPhone XS', systemVersion: '14.8', appVersion: '8.9.5', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'iPhone 14 Plus', systemVersion: '16.3', appVersion: '9.6.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'iPhone 15', systemVersion: '17.0', appVersion: '9.7.1', langCode: 'en', systemLangCode: 'en-US' },

  // Additional Android brands
  { deviceModel: 'Infinix Note 12', systemVersion: 'Android 12', appVersion: '9.3.4', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Tecno Camon 19 Pro', systemVersion: 'Android 12', appVersion: '9.3.3', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Nokia G60 5G', systemVersion: 'Android 12', appVersion: '9.3.2', langCode: 'en', systemLangCode: 'en-GB' },
  { deviceModel: 'Sony Xperia 5 IV', systemVersion: 'Android 13', appVersion: '9.5.8', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Asus ROG Phone 6', systemVersion: 'Android 12', appVersion: '9.4.7', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'Asus Zenfone 9', systemVersion: 'Android 13', appVersion: '9.5.6', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'LG Velvet', systemVersion: 'Android 11', appVersion: '9.2.0', langCode: 'en', systemLangCode: 'en-US' },
  { deviceModel: 'ZTE Blade A72', systemVersion: 'Android 11', appVersion: '9.1.7', langCode: 'en', systemLangCode: 'en-US' },
];

const USER_AGENT_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
];

export function randomFingerprint() {
  const base = DEVICE_POOL[Math.floor(Math.random() * DEVICE_POOL.length)];
  const ua = USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
  return { ...base, userAgent: ua };
}

// Per-account stable fingerprint — same device within one process run.
// Prevents Telegram seeing the same auth key "switch devices" every reconnect.
const _cache = new Map();
export function getAccountFingerprint(accountId) {
  const key = accountId.toString();
  if (!_cache.has(key)) _cache.set(key, randomFingerprint());
  return _cache.get(key);
}

// Generates a random RFC-1918 private IP (just for fingerprint metadata diversity)
export function randomLocalIp() {
  const ranges = [
    () => `192.168.${rand(0, 255)}.${rand(1, 254)}`,
    () => `10.${rand(0, 255)}.${rand(0, 255)}.${rand(1, 254)}`,
    () => `172.${rand(16, 31)}.${rand(0, 255)}.${rand(1, 254)}`,
  ];
  return ranges[Math.floor(Math.random() * ranges.length)]();
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
