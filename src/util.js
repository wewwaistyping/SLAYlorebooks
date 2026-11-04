import { tr, isRu, pluralEn } from './i18n.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Rough token estimate for list rows; the editor shows the exact count. */
export const approxTokens = s => Math.round((s || '').length / 3.3);

/** "198" for exact counts, "≈198" for estimates. */
export const tokLabel = ({ n, exact }) => (exact ? '' : '≈') + fmtTokens(n);

const DEC = isRu ? ',' : '.';
export const fmtTokens = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', DEC) + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace('.', DEC) + 'k' : String(n);

export function plural(n, one, few, many) {
    if (!isRu) return pluralEn(n, one);
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}

export function debounce(fn, ms) {
    let t = 0;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
}

const PREFS_KEY = 'lbw:prefs';
let prefsCache = null;
export function prefs() {
    if (prefsCache) return prefsCache;
    try { prefsCache = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { prefsCache = {}; }
    prefsCache.collapsed ??= {};
    prefsCache.lastUid ??= {};
    return prefsCache;
}
export const savePrefs = debounce(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache)); } catch { /* storage unavailable */ }
}, 300);

export const isSeparator = e => /^\s*={2,}/.test(e?.comment || '');
export const folderName = e => (e.comment || '').replace(/^\s*=+\s*/, '').replace(/\s*=+\s*$/, '') || tr('(папка)');

export const POSITIONS = [
    { v: '0', l: tr('↑Char · перед персонажем') },
    { v: '1', l: tr('Char↓ · после персонажа') },
    { v: '5', l: tr('↑EM · перед примерами') },
    { v: '6', l: tr('EM↓ · после примеров') },
    { v: '2', l: tr('↑AN · перед заметкой автора') },
    { v: '3', l: tr('AN↓ · после заметки автора') },
    { v: '4:0', l: tr('@D ⚙ · на глубине, система') },
    { v: '4:1', l: tr('@D 👤 · на глубине, юзер') },
    { v: '4:2', l: tr('@D 🤖 · на глубине, ассистент') },
    { v: '7', l: tr('Outlet · в именованный слот') },
];
export function positionValue(e) {
    return e.position === 4 ? `4:${e.role ?? 0}` : String(e.position ?? 0);
}
export function positionShort(e) {
    switch (Number(e.position)) {
        case 0: return '↑Char';
        case 1: return 'Char↓';
        case 2: return '↑AN';
        case 3: return 'AN↓';
        case 4: return '@D' + (e.depth ?? 4);
        case 5: return '↑EM';
        case 6: return 'EM↓';
        case 7: return 'Out';
        default: return '?';
    }
}
