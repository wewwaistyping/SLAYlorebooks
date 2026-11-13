import {
    parseRegexFromString,
    world_info_case_sensitive,
    world_info_match_whole_words,
} from '../../../../world-info.js';
import { substituteParams } from '../../../../../script.js';
import { esc } from './util.js';
import { tr } from './i18n.js';

// ---------- readable keys ----------
// Turns ST regex keys into segments: {t:'s', v:'Волк'} literal text, {t:'e', v:{alts, opt}} endings, {t:'e', v:{any:true}} any ending.
const BOUND_PRE = [/^\(\?:\^\|\[\^[^\]]+\]\)/, /^\\b/, /^\(\?<!\[\^?[^\]]+\]\)/];
const BOUND_SUF = [/\(\?:\[\^[^\]]+\]\|\$\)$/, /\(\?=\[\^[^\]]+\]\|\$\)$/, /\\b$/, /\(\?!\[[^\]]+\]\)$/];
const humanCache = new Map();

export function humanize(key) {
    if (humanCache.has(key)) return humanCache.get(key);
    const r = humanizeRaw(key);
    if (humanCache.size > 5000) humanCache.delete(humanCache.keys().next().value);
    humanCache.set(key, r);
    return r;
}

function humanizeRaw(key) {
    const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(key);
    if (!m) return { ok: true, plain: true, segs: [{ t: 's', v: key }] };
    let body = m[1];
    for (const r of BOUND_PRE) body = body.replace(r, '');
    for (const r of BOUND_SUF) body = body.replace(r, '');
    const segs = [];
    const push = (t, v) => {
        const last = segs[segs.length - 1];
        if (t === 's' && last && last.t === 's') last.v += v; else segs.push({ t, v });
    };
    let i = 0;
    while (i < body.length) {
        const rest = body.slice(i);
        let mm;
        if ((mm = /^\[([A-ZА-ЯЁ])([a-zа-яё])\]/.exec(rest)) && mm[1].toLowerCase() === mm[2]) { push('s', mm[1]); i += mm[0].length; continue; }
        if ((mm = /^\(\?:([^()?:\\[\]|]*(?:\|[^()?:\\[\]|]*)*)\)(\?)?/.exec(rest))) {
            const alts = mm[1].split('|');
            const opt = !!mm[2] || alts.includes('');
            const clean = alts.filter(a => a !== '');
            if (clean.length === 2 && clean.every(a => a.length === 1) && clean.includes('ё') && !opt) push('s', 'ё');
            else push('e', { alts: clean, opt });
            i += mm[0].length; continue;
        }
        if ((mm = /^\[[а-яёА-ЯЁa-zA-Z\-]+\]\*/.exec(rest))) { push('e', { any: true }); i += mm[0].length; continue; }
        if ((mm = /^\[([а-яёa-z])([а-яёa-z])\]/.exec(rest))) { push('s', mm[0].includes('ё') ? 'ё' : mm[1]); i += mm[0].length; continue; }
        if ((mm = /^\[(?:\\s-|-\\s|\\s\\-)\][+*?]?/.exec(rest))) { push('s', '-'); i += mm[0].length; continue; }
        if ((mm = /^\\s[+*?]?/.exec(rest))) { push('s', ' '); i += mm[0].length; continue; }
        if ((mm = /^\\([.\-()\/'])/.exec(rest))) { push('s', mm[1]); i += 2; continue; }
        if ((mm = /^\\b/.exec(rest))) { i += 2; continue; }
        if ((mm = /^([A-Za-zА-Яа-яЁё'’])\?/.exec(rest))) { if (/['’]/.test(mm[1])) push('s', mm[1]); else push('e', { alts: [mm[1]], opt: true }); i += 2; continue; }
        if (/^[A-Za-zА-Яа-яЁё0-9 \-'’,.]/.test(rest)) { push('s', rest[0]); i += 1; continue; }
        return { ok: false, raw: key };
    }
    return { ok: true, segs, flags: m[2] };
}

/** Short word-like form for list rows: endings collapse to the first variant. */
export function keyWordForm(key) {
    const h = humanize(key);
    if (!h.ok) return 'regex';
    return h.segs.map(s => s.t === 's' ? s.v : s.v.any ? '…' : (s.v.opt ? '' : (s.v.alts[0] || ''))).join('').trim();
}

/** Chip HTML. raw=true shows the stored key text. */
export function keyChipInner(key, raw) {
    const h = humanize(key);
    if (raw || !h.ok) return `<span class="lbw-kc-t">${h.ok ? '' : '<b class="lbw-kc-badge">regex</b>'}<span class="lbw-kc-raw">${esc(key)}</span></span>`;
    const inner = h.segs.map(s => s.t === 's' ? esc(s.v)
        : s.v.any ? '<em class="lbw-any">…</em>'
            : `<em>${s.v.alts.map(esc).join('<i>|</i>')}</em>`).join('');
    const ci = h.plain ? '' : (h.flags || '').includes('i') ? '<i class="lbw-kf">Aa</i>' : '';
    return `<span class="lbw-kc-t">${inner}${ci}</span>`;
}

// ---------- key builder ----------
const RU_B = '(?:^|[^а-яА-ЯёЁ])';
const RU_A = '(?:[^а-яА-ЯёЁ]|$)';
const rxEsc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export const BUILDER_TYPES = {
    ru: [
        { v: 'a', l: tr('на -а (Лиса, Книга)') },
        { v: 'm', l: tr('на согласную, -й, -ь (Волк, Конь)') },
        { v: 'ya', l: tr('на -я (Буря, Неделя)') },
        { v: 'adj', l: tr('прилагательное (Старый)') },
        { v: 'any', l: tr('любое окончание (пиши корень)') },
        { v: 'exact', l: tr('без окончаний') },
    ],
    en: [
        { v: 'exact', l: tr('как есть') },
        { v: 'pl', l: tr('+ s во множественном') },
    ],
};

export const isLatin = w => /^[A-Za-z][A-Za-z\s'’-]*$/.test(w.trim());

function capClass(s) {
    const c = s[0];
    if (!c || c.toLowerCase() === c.toUpperCase()) return rxEsc(s);
    return `[${c.toUpperCase()}${c.toLowerCase()}]` + rxEsc(s.slice(1));
}

export function buildKey(word, type) {
    word = (word || '').trim().replace(/\s+/g, ' ');
    if (!word) return '';
    if (isLatin(word)) {
        const parts = word.split(' ');
        const body = parts.map((p, i) => i === 0 ? capClass(p) : rxEsc(p)).join('\\s+');
        return `/\\b${body}${type === 'pl' ? 's?' : ''}\\b/`;
    }
    const parts = word.split(' ');
    const last = parts.pop();
    const lo = last.toLowerCase();
    let stem = last, alts = null, opt = false, any = false;
    if (type === 'a' && /а$/.test(lo)) {
        stem = last.slice(0, -1);
        alts = /[гкхжшчщ]$/i.test(stem) ? ['а', 'и', 'е', 'у', 'ой'] : ['а', 'ы', 'е', 'у', 'ой'];
    } else if (type === 'ya' && /я$/.test(lo)) {
        stem = last.slice(0, -1);
        alts = /ь$/i.test(stem) ? ['я', 'и', 'е', 'ю', 'ей', 'ёй'] : ['я', 'и', 'е', 'ю', 'ей'];
    } else if (type === 'adj' && /(ый|ий|ой)$/.test(lo)) {
        stem = last.slice(0, -2);
        alts = /ий$/.test(lo) ? ['ий', 'его', 'ему', 'им', 'ем'] : ['ый', 'ого', 'ому', 'ым', 'ом'];
    } else if (type === 'm') {
        if (/[йь]$/.test(lo)) { stem = last.slice(0, -1); alts = [lo.slice(-1), 'я', 'ю', 'ем', 'е']; }
        else { alts = ['а', 'у', 'ом', 'е']; opt = true; }
    } else if (type === 'any') {
        any = true;
    }
    const head = parts.map((p, i) => (i === 0 ? capClass(p) : rxEsc(p)) + '\\s+').join('');
    const tail = (parts.length ? rxEsc(stem) : capClass(stem)) + (any ? '[а-яё]*' : alts ? `(?:${alts.join('|')})${opt ? '?' : ''}` : '');
    return `/${RU_B}${head}${tail}${RU_A}/`;
}

// ---------- matching, same rules as SillyTavern's WorldInfoBuffer.matchKeys ----------
// Macro substitution is slow (~8 µs per key) and almost no key has macros, so only keys with "{{" go through it.
const subst = key => String(/\{\{|<(?:USER|BOT)>/i.test(String(key)) ? (substituteParams(key) ?? '') : key).trim();
const rxCache = new Map();
function getRegex(needle) {
    if (rxCache.has(needle)) return rxCache.get(needle);
    const r = parseRegexFromString(needle);
    if (rxCache.size > 5000) rxCache.delete(rxCache.keys().next().value);
    rxCache.set(needle, r);
    return r;
}
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCache = new Map();
function wholeWord(nd) {
    let r = wordCache.get(nd);
    if (!r) {
        r = new RegExp(`(?:^|\\W)(${escapeRegex(nd)})(?:$|\\W)`);
        if (wordCache.size > 5000) wordCache.clear();
        wordCache.set(nd, r);
    }
    return r;
}

export function keyMatches(text, key, entry) {
    const needle = subst(key);
    if (!needle) return false;
    const rx = getRegex(needle);
    if (rx) { rx.lastIndex = 0; return rx.test(text); }
    const cs = entry.caseSensitive ?? world_info_case_sensitive;
    const hay = cs ? text : text.toLowerCase();
    const nd = cs ? needle : needle.toLowerCase();
    const ww = entry.matchWholeWords ?? world_info_match_whole_words;
    if (ww) {
        if (nd.split(/\s+/).length > 1) return hay.includes(nd);
        return wholeWord(nd).test(hay);
    }
    return hay.includes(nd);
}

/** Primary + secondary keys with selectiveLogic, as in checkWorldInfo. Returns the matching primary key or null. */
export function entryMatches(entry, text) {
    if (!Array.isArray(entry.key) || !entry.key.length) return null;
    const primary = entry.key.find(k => keyMatches(text, k, entry));
    if (!primary) return null;
    const sec = entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length ? entry.keysecondary : null;
    if (!sec) return primary;
    const logic = entry.selectiveLogic ?? 0;
    const hits = sec.map(k => keyMatches(text, k, entry));
    const any = hits.some(Boolean), all = hits.every(Boolean);
    const ok = logic === 0 ? any : logic === 1 ? !all : logic === 2 ? !any : logic === 3 ? all : any;
    return ok ? primary : null;
}

/** Character ranges where the entry's primary keys match, trimmed to letters/digits. */
export function keyRanges(entry, text) {
    const out = [];
    for (const key of entry.key || []) {
        const needle = subst(key);
        if (!needle) continue;
        const rx = getRegex(needle);
        let g;
        if (rx) g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
        else {
            const cs = entry.caseSensitive ?? world_info_case_sensitive;
            g = new RegExp(escapeRegex(needle), cs ? 'g' : 'gi');
        }
        let m, guard = 0;
        while ((m = g.exec(text)) && guard++ < 200) {
            if (!m[0]) { g.lastIndex++; continue; }
            let s = m.index, e = m.index + m[0].length;
            while (s < e && !/[\p{L}\p{N}]/u.test(text[s])) s++;
            while (e > s && !/[\p{L}\p{N}]/u.test(text[e - 1])) e--;
            if (e > s) out.push([s, e]);
        }
    }
    return out;
}
