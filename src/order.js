import { setWIOriginalDataValue } from '../../../../world-info.js';
import { store, entries, markDirty } from './store.js';
import { sortEntries, folderLayout, di } from './sort.js';
import { prefs, savePrefs } from './util.js';

function setDisplayIndex(e, value) {
    if (e.displayIndex === value) return;
    e.displayIndex = value;
    setWIOriginalDataValue(store.data, e.uid, 'extensions.display_index', value);
    markDirty(e.uid);
}

function setOrder(e, value) {
    if (e.order === value) return;
    e.order = value;
    setWIOriginalDataValue(store.data, e.uid, 'insertion_order', value);
    markDirty(e.uid);
}

// ---------- "order follows the place in the list" ----------
// Per book: 'on', 'off' or 'auto' (on when the orders already go strictly down the list, like 1000, 999, …).
export function orderMode() {
    const p = prefs();
    p.orderMode ??= {};
    return p.orderMode[store.name] ?? 'auto';
}
export function setOrderMode(mode) {
    const p = prefs();
    p.orderMode ??= {};
    p.orderMode[store.name] = mode;
    savePrefs();
}
/**
 * True only when order already counts down by exactly 1 along the list (1000, 999, 998, …).
 * Merely decreasing orders (300, 200, 100) do not count: renumbering them would shift the book
 * against entries of other lorebooks, which ST sorts together with these.
 */
export function looksOrdered(seq = sortEntries(entries(), 'custom')) {
    if (seq.length < 3) return false;
    for (let i = 0; i < seq.length - 1; i++) {
        if (Number(seq[i].order) - Number(seq[i + 1].order) !== 1) return false;
    }
    return true;
}
export function orderFollowsPosition() {
    const m = orderMode();
    if (m === 'on') return true;
    if (m === 'off') return false;
    // Remember the detection, so a later deletion (which leaves a gap) does not silently switch it off.
    if (looksOrdered()) { setOrderMode('on'); return true; }
    return false;
}

/** order = 1000, 999, … down the custom order (more than 1000 entries start higher). */
export function renumberOrders(seq = sortEntries(entries(), 'custom')) {
    const top = Math.max(1000, seq.length - 1);
    seq.forEach((e, i) => setOrder(e, top - i));
}

function applySequence(seq, renumber) {
    seq.forEach((e, i) => setDisplayIndex(e, i));
    if (renumber) renumberOrders(seq);
}

/**
 * Moves entries (kept in their current relative order) before/after the target entry.
 * targetUid null = to the end. Returns false when nothing moved.
 */
export function moveEntries(uids, targetUid, where = 'after') {
    const follow = orderFollowsPosition();
    const ids = new Set(uids.map(Number));
    if (targetUid != null && ids.has(Number(targetUid))) return false;
    const seq = sortEntries(entries(), 'custom');
    const moving = seq.filter(e => ids.has(e.uid));
    if (!moving.length) return false;
    const rest = seq.filter(e => !ids.has(e.uid));
    let i = targetUid == null ? rest.length : rest.findIndex(e => e.uid === Number(targetUid));
    if (i < 0) i = rest.length;
    else if (where === 'after') i++;
    rest.splice(i, 0, ...moving);
    applySequence(rest, follow);
    return true;
}

/**
 * One step up or down in the custom order (the ↑↓ buttons; touch screens cannot drag).
 * An entry passing a separator lands in the neighbouring folder. A lone separator moves its whole
 * folder past the neighbouring folder. Several entries move as a block. Returns false at the edge.
 */
export function moveStep(uids, dir) {
    const ids = new Set(uids.map(Number));
    const seq = sortEntries(entries(), 'custom');
    const picked = seq.filter(e => ids.has(e.uid));
    if (!picked.length) return false;
    const isSep = e => /^\s*={2,}/.test(e?.comment || '');
    if (picked.length === 1 && isSep(picked[0])) {
        const start = seq.indexOf(picked[0]);
        let end = start;
        while (end + 1 < seq.length && !isSep(seq[end + 1])) end++;
        const block = seq.slice(start, end + 1).map(e => e.uid);
        if (dir < 0) {
            let p = start - 1;
            while (p >= 0 && !isSep(seq[p])) p--;
            if (p < 0) return false; // entries without a folder must stay above the first folder
            return moveEntries(block, seq[p].uid, 'before');
        }
        if (end + 1 >= seq.length) return false;
        let e2 = end + 1;
        while (e2 + 1 < seq.length && !isSep(seq[e2 + 1])) e2++;
        return moveEntries(block, seq[e2].uid, 'after');
    }
    const first = seq.indexOf(picked[0]);
    const last = seq.indexOf(picked[picked.length - 1]);
    if (dir < 0) {
        const t = seq.slice(0, first).reverse().find(e => !ids.has(e.uid));
        return t ? moveEntries([...ids], t.uid, 'before') : false;
    }
    const t = seq.slice(last + 1).find(e => !ids.has(e.uid));
    return t ? moveEntries([...ids], t.uid, 'after') : false;
}

/** Moves entries to the end of a folder. sepUid null = the part before the first separator. */
export function moveToFolder(uids, sepUid) {
    const ids = new Set(uids.map(Number));
    const { folders } = folderLayout(entries());
    const f = folders.find(x => (x.sep ? x.sep.uid : null) === sepUid);
    if (!f) return false;
    const items = f.items.filter(e => !ids.has(e.uid));
    if (items.length) return moveEntries(uids, items[items.length - 1].uid, 'after');
    if (f.sep) return moveEntries(uids, f.sep.uid, 'after');
    const firstSep = folders.find(x => x.sep)?.sep;
    return moveEntries(uids, firstSep ? firstSep.uid : null, firstSep ? 'before' : 'after');
}

/** Puts a new entry right after `ref` in the custom order. Call orderFollowsPosition() before creating the entry. */
export function insertAfter(e, ref, { renumber = false } = {}) {
    const others = entries().filter(x => x.uid !== e.uid);
    if (!ref) {
        setDisplayIndex(e, others.reduce((m, x) => Math.max(m, di(x)), -1) + 1);
    } else {
        const at = di(ref);
        for (const x of others) {
            if (x.uid !== ref.uid && di(x) > at) setDisplayIndex(x, di(x) + 1);
        }
        setDisplayIndex(e, at + 1);
    }
    if (renumber) renumberOrders();
}

/** Settings a new entry borrows from its neighbour, so it lands in the same place in the prompt. */
const INHERIT = ['position', 'role', 'depth', 'order', 'probability', 'useProbability', 'preventRecursion', 'excludeRecursion',
    'delayUntilRecursion', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'selectiveLogic', 'vectorized'];

export function inheritSettings(e, from) {
    if (!from) return;
    for (const k of INHERIT) {
        if (from[k] !== undefined) e[k] = structuredClone(from[k]);
    }
    e.constant = false;
}
