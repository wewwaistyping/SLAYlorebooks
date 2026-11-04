import {
    parseRegexFromString,
    world_info_recursive,
    world_info_match_whole_words,
} from '../../../../world-info.js';
import { entryMatches } from './keys.js';
import { isSeparator } from './util.js';
import { tr } from './i18n.js';

// "Will this entry actually fire?" Problems are either errors (it cannot work as written)
// or warnings (it works, but probably not the way it was meant to).

const REGEX_BITS = /\\[sSbBdDwW]|\(\?[:=!<]|\[\^|\(\?:\^|\)\/[a-z]*\s*,/;

/** @returns {{sev:'error'|'warn', msg:string} | null} */
export function keyIssue(key, entry) {
    if (typeof key !== 'string') return { sev: 'error', msg: tr('Ключ не строка, ST его не прочитает.') };
    const k = key.trim();
    if (!k) return null;
    if (k.startsWith('/')) {
        const rx = parseRegexFromString(k);
        if (!rx) {
            const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(k);
            let why = tr('нет закрывающего «/» с флагами');
            if (m) {
                try { new RegExp(m[1], m[2]); why = tr('внутри есть «/» без обратного слэша'); }
                catch (e) { why = tr('ошибка в выражении: ') + e.message.replace(/^Invalid regular expression: /, ''); }
            }
            return { sev: 'error', msg: tr('Похоже на regex, но ST его не разберёт ({0}) и будет искать этот текст буква в букву. Не сработает.', why) };
        }
        if (rx.test('') || rx.test('\x01')) return { sev: 'warn', msg: tr('Regex совпадает даже с пустым текстом: запись будет срабатывать всегда.') };
        return null;
    }
    if (REGEX_BITS.test(k)) {
        return { sev: 'error', msg: tr('Обрывок regex: нет «/» в начале, поэтому ST ищет эти символы как обычный текст. Не сработает.') };
    }
    if (k.includes(',')) {
        const n = k.split(',').filter(s => s.trim()).length;
        return { sev: 'error', msg: tr('Похоже, {0} ключей склеены в один: ST ищет всю строку с запятыми целиком, поэтому почти наверняка не сработает.', n) };
    }
    const ww = entry.matchWholeWords ?? world_info_match_whole_words;
    if (!ww && /^[\p{L}]{1,3}$/u.test(k)) {
        return { sev: 'warn', msg: tr('Короткий ключ «{0}» ловится и внутри других слов (поиск целых слов выключен).', k) };
    }
    return null;
}

/** A leading @@activate decorator switches the entry on without keys. */
export const isForced = e => /^\s*(?:@@[^\n]*\n\s*)*@@activate\b/.test(String(e.content || ''));
/** A leading @@dont_activate decorator keeps the entry out even when its keys match. */
export const isSuppressed = e => /^\s*(?:@@[^\n]*\n\s*)*@@dont_activate\b/.test(String(e.content || ''));

/** Constants (and @@activate) fire without keys, so a broken key there is harmless until the mode changes. */
function softenFor(e, p) {
    if (!p || !(e.constant || isForced(e))) return p;
    return { sev: 'warn', msg: tr('Запись срабатывает всегда, ключи сейчас не используются. Но если сменить режим: ') + p.msg.charAt(0).toLowerCase() + p.msg.slice(1) };
}

/** keyIssue with the entry's mode taken into account (for chips in the editor). */
export const keyIssueFor = (key, e) => softenFor(e, keyIssue(key, e));

/**
 * @param {object} e entry
 * @param {object[]} all all entries of the same book (for recursion checks)
 * @returns {{sev:'error'|'warn', msg:string, key?:string}[]}
 */
export function checkEntry(e, all = []) {
    const out = [];
    if (!e || isSeparator(e) || e.disable) return out;
    const content = String(e.content || '');
    const primary = (Array.isArray(e.key) ? e.key : []).filter(k => String(k ?? '').trim());
    const secondary = (Array.isArray(e.keysecondary) ? e.keysecondary : []).filter(k => String(k ?? '').trim());
    const forced = isForced(e);
    const byKeys = !e.constant && !e.vectorized && !forced;
    const soften = p => softenFor(e, p);

    let brokenPrimary = 0;
    for (const k of primary) {
        const p = keyIssue(k, e);
        if (p) { out.push({ ...soften(p), key: k }); if (p.sev === 'error') brokenPrimary++; }
    }
    for (const k of secondary) {
        const p = keyIssue(k, e);
        if (p) { const s = soften(p); out.push({ ...s, key: k, msg: tr('Вторичный ключ. ') + s.msg }); }
    }

    const blank = !content.trim();
    if (byKeys && !primary.length && blank) { out.push({ sev: 'warn', msg: tr('Пустая заготовка: нет ни ключей, ни текста.') }); return out; }
    if (byKeys && !primary.length) out.unshift({ sev: 'error', msg: tr('Режим «По ключам», а ключей нет: сама запись не сработает никогда. Это нормально, только если её включает расширение или скрипт.') });
    else if (byKeys && primary.length && brokenPrimary === primary.length) out.unshift({ sev: 'error', msg: tr('Ни один ключ не рабочий: запись никогда не сработает.') });
    else if (e.vectorized && !e.constant && primary.length && brokenPrimary === primary.length) out.unshift({ sev: 'warn', msg: tr('Ни один ключ не рабочий: запись включится только через векторный поиск.') });

    if (secondary.length && e.selective === false) out.push({ sev: 'warn', msg: tr('Вторичные ключи заданы, но выключены (selective): ST их не проверяет.') });
    if (e.useProbability !== false && Number(e.probability) === 0) out.push({ sev: 'error', msg: tr('Шанс 0%: запись не сработает никогда.') });
    if (Number(e.position) === 7 && !String(e.outletName || '').trim()) out.push({ sev: 'error', msg: tr('Позиция Outlet без имени слота: текст никуда не попадёт.') });
    if (e.scanDepth === 0) out.push({ sev: 'warn', msg: tr('Глубина сканирования 0: ST ничего не сканирует для этой записи, даже текст рекурсии, по ключам она не сработает.') });
    if (/^\s*@@dont_activate\b/.test(content)) out.push({ sev: 'warn', msg: tr('Текст начинается с @@dont_activate: сама по ключам запись не включится.') });

    if (e.delayUntilRecursion && !e.constant) {
        if (!world_info_recursive) out.push({ sev: 'error', msg: tr('Стоит «Только через рекурсию», а рекурсия выключена в глобальных настройках: не сработает.') });
        else if (all.length) {
            const pullers = all.filter(x => x !== e && !isSeparator(x) && !x.disable && !x.preventRecursion && x.content && entryMatches(e, '\x01' + x.content));
            if (!pullers.length) out.push({ sev: 'warn', msg: tr('Стоит «Только через рекурсию», но ни одна запись её не подтягивает.') });
        }
    }

    const cf = e.characterFilter;
    if (cf && !cf.isExclude && Array.isArray(cf.names) && cf.names.length && !(cf.tags || []).length) {
        const chars = new Set((SillyTavern.getContext().characters || []).map(c => String(c.avatar || '').replace(/\.[^/.]+$/, '')));
        if (chars.size && !cf.names.some(n => chars.has(n))) out.push({ sev: 'warn', msg: tr('Привязана к персонажам, которых больше нет в таверне: не сработает ни у кого.') });
    }

    if (blank && (primary.length || e.constant)) out.push({ sev: 'warn', msg: tr('Пустой текст: сработает, но ничего не добавит.') });
    return out;
}

/** Problems of the open book, shared by the list (row marks), the editor and the check tab. */
export const bookIssues = { map: new Map() };

/** key text → entries that use it as a primary key (enabled, non-constant, non-separator). */
function keyIndex(all) {
    const idx = new Map();
    for (const x of all) {
        if (!x || isSeparator(x) || x.disable || x.constant) continue;
        for (const k of new Set((Array.isArray(x.key) ? x.key : []).map(k => String(k ?? '').trim()).filter(Boolean))) {
            if (!idx.has(k)) idx.set(k, []);
            idx.get(k).push(x);
        }
    }
    return idx;
}

/** The same key in several entries: they always fire together. */
function dupKeyIssues(e, idx) {
    if (!e || isSeparator(e) || e.disable || e.constant) return [];
    const out = [];
    for (const k of new Set((Array.isArray(e.key) ? e.key : []).map(k => String(k ?? '').trim()).filter(Boolean))) {
        const others = (idx.get(k) || []).filter(x => x.uid !== e.uid);
        if (!others.length) continue;
        const names = others.map(x => `«${x.comment || 'UID ' + x.uid}»`);
        out.push({ sev: 'warn', key: k, msg: tr('Этот же ключ есть в {0}: записи всегда срабатывают вместе.', names.slice(0, 3).join(', ') + (names.length > 3 ? tr(' и ещё {0}', names.length - 3) : '')) });
    }
    return out;
}

/** Everything about one entry, including book-level duplicates. */
export function issuesFor(e, all) {
    return [...checkEntry(e, all), ...dupKeyIssues(e, keyIndex(all))];
}

/** @returns {Map<number, {sev, msg, key?}[]>} only entries that have problems */
export function checkBook(entries) {
    const map = new Map();
    const idx = keyIndex(entries);
    for (const e of entries) {
        const issues = [...checkEntry(e, entries), ...dupKeyIssues(e, idx)];
        if (issues.length) map.set(e.uid, issues);
    }
    return map;
}

export const worst = issues => issues?.some(i => i.sev === 'error') ? 'error' : issues?.length ? 'warn' : null;
