import { getCurrentLocale } from '../../../../i18n.js';
import { EN, EN_PLURAL } from './en.js';

// The Russian text is the key. ST ships only "ru-ru", so a Russian browser with no language picked reports "ru"
// and ST's own labels stay English; that user still reads Russian, so any "ru*" locale counts.
export const isRu = String(getCurrentLocale() || '').toLowerCase().startsWith('ru');

/** tr('Выбрано {0} {1}', n, word): the string for the current language with {0}, {1}… filled in. */
export function tr(ru, ...args) {
    const s = isRu ? ru : EN[ru] ?? ru;
    return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => args[i]) : s;
}

/** English form of a word that plural() received in Russian; `one` is its first Russian form. */
export function pluralEn(n, one) {
    const forms = EN_PLURAL[one];
    return forms ? forms[n === 1 ? 0 : 1] : one;
}
