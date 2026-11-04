import { val } from './store.js';
import { isSeparator } from './util.js';
import { tr, isRu } from './i18n.js';

export const SORTS = [
    { v: 'custom', l: tr('Свой порядок'), folders: true },
    { v: 'priority', l: tr('Приоритет, как в ST'), folders: true },
    { v: 'order', l: 'Order ↓' },
    { v: 'title', l: tr('Название А–Я') },
    { v: 'tokens', l: tr('Размер ↓') },
    { v: 'uid', l: 'UID ↑' },
];

export const di = e => e.displayIndex ?? e.uid;

export function sortEntries(list, sort) {
    const byOrder = (a, b) => (val(b, 'order') - val(a, 'order')) || (a.uid - b.uid);
    const cmp = {
        custom: (a, b) => (di(a) - di(b)) || byOrder(a, b),
        priority: (a, b) => {
            const r = x => x.disable ? 2 : x.constant ? 0 : 1;
            return (r(a) - r(b)) || byOrder(a, b);
        },
        order: byOrder,
        title: (a, b) => String(a.comment || '').localeCompare(String(b.comment || ''), isRu ? 'ru' : 'en') || (a.uid - b.uid),
        tokens: (a, b) => (String(b.content || '').length - String(a.content || '').length) || (a.uid - b.uid),
        uid: (a, b) => a.uid - b.uid,
    }[sort] || ((a, b) => di(a) - di(b));
    return [...list].sort(cmp);
}

/** Entries in custom order, split into folders by "===" separator entries. The first folder has no separator. */
export function folderLayout(all) {
    const seq = sortEntries(all, 'custom');
    const folders = [];
    let cur = { sep: null, items: [] };
    folders.push(cur);
    for (const e of seq) {
        if (isSeparator(e)) { cur = { sep: e, items: [] }; folders.push(cur); }
        else cur.items.push(e);
    }
    return { seq, folders };
}

export function folderOf(all, uid) {
    const { folders } = folderLayout(all);
    return folders.find(f => f.sep?.uid === uid || f.items.some(e => e.uid === uid)) || null;
}
