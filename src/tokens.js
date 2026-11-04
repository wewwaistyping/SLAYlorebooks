// Exact token counts (SillyTavern's own tokenizer) for list rows, folders and totals.
// Counted in the background, three at a time, cached by text; until a count arrives the UI shows "≈".
// The cache is also kept in localStorage, so a lorebook opened once stays exact after a reload
// (phones reload the tab often, and every count is a request to the server).
import { getFriendlyTokenizerName } from '../../../../tokenizers.js';
import { approxTokens } from './util.js';

const STORE_KEY = 'slaylore.tokens';
const MEM_CAP = 20000;
const DISK_CAP = 6000;
const MAX_PARALLEL = 3;

const cache = new Map();      // text -> number, for the current tokenizer only
const pending = new Set();    // texts queued or being counted
const queue = [];
let running = 0;
let listener = null;
let ready = new Set();
let notifyTimer = 0;
let tokenizer = '';           // tokenizer the cache belongs to
let disk = new Map();         // hash -> number, mirrored to localStorage
let diskTimer = 0;

export function onTokens(fn) { listener = fn; }

/** Counts depend on the tokenizer; switching API or model empties the cache. */
function tokenizerKey() {
    try {
        const t = getFriendlyTokenizerName();
        return `${t.tokenizerKey}|${t.tokenizerName}`;
    } catch { return 'unknown'; }
}

function syncTokenizer() {
    const k = tokenizerKey();
    if (k === tokenizer) return;
    tokenizer = k;
    cache.clear();
    forgetQueue();
    disk = loadDisk(k);
}

// 32-bit FNV-1a plus the length: enough to tell lorebook entries apart.
function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + ':' + s.length;
}

function loadDisk(k) {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (raw && raw.tokenizer === k && raw.counts && typeof raw.counts === 'object') return new Map(Object.entries(raw.counts));
    } catch { /* no storage or corrupt: start empty */ }
    return new Map();
}

function saveDiskSoon() {
    clearTimeout(diskTimer);
    diskTimer = setTimeout(() => {
        try {
            while (disk.size > DISK_CAP) disk.delete(disk.keys().next().value);
            localStorage.setItem(STORE_KEY, JSON.stringify({ tokenizer, counts: Object.fromEntries(disk) }));
        } catch { /* storage full or disabled: the in-memory cache still works */ }
    }, 2000);
}

/** { n, exact } — the cached exact count or the estimate. */
export function tokenInfo(text) {
    const s = text ?? '';
    if (!s) return { n: 0, exact: true };
    let n = cache.get(s);
    if (n == null) {
        const d = disk.get(hash(s));
        if (d != null) { n = d; cache.set(s, n); }
    }
    return n != null ? { n, exact: true } : { n: approxTokens(s), exact: false };
}

/** Sum of several texts; exact only when every part is exact. */
export function tokenSum(texts) {
    let n = 0, exact = true;
    for (const t of texts) { const i = tokenInfo(t); n += i.n; if (!i.exact) exact = false; }
    return { n, exact };
}

export function requestTokens(texts) {
    syncTokenizer();
    for (const t of texts) {
        const s = t ?? '';
        if (!s || pending.has(s) || tokenInfo(s).exact) continue;
        pending.add(s);
        queue.push(s);
    }
    pump();
}

/** Count one text now (used by the editor for the open entry). */
export async function countNow(text) {
    const s = text ?? '';
    if (!s) return 0;
    syncTokenizer();
    const known = tokenInfo(s);
    if (known.exact) return known.n;
    const n = await SillyTavern.getContext().getTokenCountAsync(s);
    remember(s, n);
    return n;
}

export function forgetQueue() {
    queue.length = 0;
    pending.clear();
}

function remember(s, n) {
    if (!Number.isFinite(n)) return;
    cache.set(s, n);
    if (cache.size > MEM_CAP) cache.delete(cache.keys().next().value);
    disk.set(hash(s), n);
    saveDiskSoon();
    ready.add(s);
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
        const done = ready;
        ready = new Set();
        listener?.(done);
    }, 200);
}

function pump() {
    while (running < MAX_PARALLEL && queue.length) {
        const s = queue.shift();
        const forKey = tokenizer;
        running++;
        SillyTavern.getContext().getTokenCountAsync(s)
            .then(n => { if (forKey === tokenizer) remember(s, n); })
            .catch(() => { /* tokenizer unavailable: keep the estimate */ })
            .finally(() => { pending.delete(s); running--; pump(); });
    }
}
