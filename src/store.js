import {
    worldInfoCache,
    setWIOriginalDataValue,
    deleteWIOriginalDataValue,
    originalWIDataKeyMap,
    newWorldInfoEntryTemplate,
} from '../../../../world-info.js';
import { eventSource, event_types, getRequestHeaders } from '../../../../../script.js';
import { tr } from './i18n.js';

/**
 * The open lorebook. `data` is our own clone; we save it with the same request ST uses,
 * so a save here never cancels another book's pending debounced save inside ST.
 */
export const store = {
    name: null,
    data: null,
    dirty: new Set(),
    saving: false,
    state: 'idle', // idle | pending | saving | error
    listeners: new Set(),
    timer: 0,
};

function emit(kind, payload) {
    for (const fn of store.listeners) {
        try { fn(kind, payload); } catch (e) { console.error('[SLAYlorebooks] listener failed', e); }
    }
}
export const onStore = fn => { store.listeners.add(fn); return () => store.listeners.delete(fn); };

let openTicket = 0;
export async function openBook(name) {
    if (store.name === name && store.data) return;
    const ticket = ++openTicket;
    await flush();
    if (ticket !== openTicket) return;
    if (store.dirty.size && store.name) {
        // The save failed and the retry is pending: never drop unsaved entries by switching away.
        toastr.error(tr('Правки в «{0}» ещё не сохранены, не переключаю лорбук. Попробую сохранить ещё раз.', store.name));
        emit('blocked', store.name);
        return;
    }
    store.name = null;
    store.data = null;
    store.dirty.clear();
    setState('idle');
    if (!name) { emit('book', null); return; }
    // Read the file itself, not ST's cache: on first load ST hands out the cached object by reference and its
    // native editor backfills template fields into it, so the cache can differ from the file. Saving our copy
    // must write back exactly the file plus the user's edits.
    let data = null;
    try {
        const res = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
            cache: 'no-cache',
        });
        if (res.ok) data = await res.json();
    } catch (e) { console.error('[SLAYlorebooks] load failed', e); }
    if (ticket !== openTicket) return; // another book was opened meanwhile
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        toastr.error(tr('Не получилось открыть лорбук «{0}»', name));
        emit('book', null);
        return;
    }
    store.name = name;
    store.data = data;
    emit('book', name);
}

export function closeBook() {
    store.name = null;
    store.data = null;
    store.dirty.clear();
    setState('idle');
    emit('book', null);
}

export const entries = () => store.data ? Object.values(store.data.entries).filter(e => e && typeof e === 'object') : [];
export const getEntry = uid => store.data?.entries?.[uid];

/** Reads a field with ST's default for fields missing from older files. */
export const val = (e, f) => e[f] ?? newWorldInfoEntryTemplate[f];

function setState(s) {
    if (store.state === s) return;
    store.state = s;
    emit('state', s);
}

export function markDirty(uid) {
    store.dirty.add(String(uid));
    scheduleSave();
}

export function scheduleSave(ms = 700) {
    if (!store.name) return;
    setState('pending');
    clearTimeout(store.timer);
    store.timer = setTimeout(() => { flush(); }, ms);
}

export async function flush() {
    clearTimeout(store.timer);
    if (!store.name || !store.data || !store.dirty.size) return;
    if (store.saving) { await store.saving; return flush(); }
    const name = store.name, data = store.data;
    const sent = new Set(store.dirty);
    setState('saving');
    store.saving = (async () => {
        try {
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name, data }),
            });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            if (store.data === data) {
                sent.forEach(u => store.dirty.delete(u));
                worldInfoCache.set(name, data);
                await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
            }
            // else: someone else saved the book while our request was in flight; store.data is already the
            // merged version and still dirty, so it is re-sent below instead of publishing this stale copy.
            setState(store.dirty.size ? 'pending' : 'idle');
            if (store.dirty.size) scheduleSave();
        } catch (e) {
            console.error('[SLAYlorebooks] save failed', e);
            setState('error');
            toastr.error(tr('SLAYlorebooks: не удалось сохранить лорбук. Правки остались в памяти, попробую ещё раз через 5 секунд.'));
            store.timer = setTimeout(() => { flush(); }, 5000);
        }
    })();
    await store.saving;
    store.saving = false;
}

/** Someone else (MemoryBooks, native popup on a clone, a script) saved our book: take theirs, keep our unsaved entries. */
eventSource.on(event_types.WORLDINFO_UPDATED, (name, data) => {
    if (!store.name || name !== store.name || !data || data === store.data) return;
    const next = structuredClone(data);
    for (const uid of store.dirty) {
        const mine = store.data.entries[uid];
        if (mine) next.entries[uid] = mine; else delete next.entries[uid];
    }
    store.data = next;
    emit('external', name);
    if (store.dirty.size) scheduleSave();
});

// ---------- field setters that mirror what the native editor writes ----------
export function setField(e, field, value) {
    e[field] = value;
    const key = originalWIDataKeyMap[field];
    if (key) setWIOriginalDataValue(store.data, e.uid, key, value);
    markDirty(e.uid);
}

export function setMode(e, mode) {
    e.constant = mode === 'constant';
    e.vectorized = mode === 'vectorized';
    setWIOriginalDataValue(store.data, e.uid, 'constant', e.constant);
    setWIOriginalDataValue(store.data, e.uid, 'extensions.vectorized', e.vectorized);
    markDirty(e.uid);
}

export function setDisabled(e, disabled) {
    e.disable = disabled;
    setWIOriginalDataValue(store.data, e.uid, 'enabled', !disabled);
    markDirty(e.uid);
}

export function setPosition(e, value) {
    const [p, r] = String(value).split(':');
    e.position = Number(p);
    e.role = e.position === 4 ? Number(r ?? 0) : null;
    setWIOriginalDataValue(store.data, e.uid, 'position', e.position === 0 ? 'before_char' : 'after_char');
    setWIOriginalDataValue(store.data, e.uid, 'extensions.position', e.position);
    setWIOriginalDataValue(store.data, e.uid, 'extensions.role', e.role);
    markDirty(e.uid);
}

export function removeEntry(uid) {
    delete store.data.entries[uid];
    deleteWIOriginalDataValue(store.data, uid);
    markDirty(uid);
}

/** Fills fields missing from older files, the same way the native editor does before rendering. */
export function fillMissing(e) {
    for (const [k, v] of Object.entries(newWorldInfoEntryTemplate)) {
        if (e[k] === undefined) e[k] = structuredClone(v);
    }
}
