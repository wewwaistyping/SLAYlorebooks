import { store, entries } from './store.js';
import { esc, tokLabel, isSeparator, folderName, positionShort, prefs, savePrefs, plural } from './util.js';
import { keyWordForm } from './keys.js';
import { bookIssues, worst } from './check.js';
import { SORTS, sortEntries } from './sort.js';
import { orderFollowsPosition } from './order.js';
import { tokenInfo, tokenSum } from './tokens.js';
import { tr } from './i18n.js';

export { SORTS, sortEntries };

export const FILTERS = [
    { id: 'all', l: tr('Все'), f: () => true },
    { id: 'con', l: tr('Константы'), f: e => !!e.constant },
    { id: 'key', l: tr('По ключам'), f: e => !e.constant && !e.vectorized },
    { id: 'depth', l: '@D', f: e => Number(e.position) === 4 },
    { id: 'empty', l: tr('Пустые'), f: e => !String(e.content || '').trim() },
    { id: 'off', l: tr('Выключенные'), f: e => !!e.disable },
];

export function dotClass(e) {
    if (e.disable) return 'off';
    if (e.constant) return 'con';
    if (e.vectorized) return 'vec';
    return 'key';
}

function rowHTML(e, { selected, checked, drag }) {
    const keys = (e.key || []).slice(0, 4).map(keyWordForm).filter(Boolean).join(' · ')
        || (e.constant ? tr('всегда в промпте') : e.vectorized ? tr('векторный поиск') : tr('нет ключей'));
    const tok = tokenInfo(e.content);
    const lvl = worst(bookIssues.map.get(e.uid));
    const flag = lvl ? `<span class="lbw-flag lbw-${lvl}" title="${lvl === 'error' ? tr('Запись не сработает или ключ сломан: открой запись или вкладку «Проверка»') : tr('Есть предупреждение: см. вкладку «Проверка»')}">${lvl === 'error' ? '✖' : '⚠'}</span>` : '';
    return `<div class="lbw-row${selected ? ' lbw-sel' : ''}${checked ? ' lbw-checked' : ''}${e.disable ? ' lbw-dis' : ''}" data-uid="${esc(e.uid)}"${drag ? ' draggable="true"' : ''}>`
        + `<input type="checkbox" class="lbw-cb" aria-label="${tr('Выделить запись')}"${checked ? ' checked' : ''}>`
        + `<span class="lbw-dot lbw-${dotClass(e)}"></span>`
        + `<span class="lbw-row-main"><span class="lbw-row-t">${flag}${esc(e.comment || tr('(без названия)'))}</span>`
        + `<span class="lbw-row-k">${esc(keys)}</span></span>`
        + `<span class="lbw-row-m"><span>${positionShort(e)}</span><span>${tok.n ? tokLabel(tok) : '—'}</span></span></div>`;
}

/**
 * @param {HTMLElement} el
 * @param {{
 *   onSelect: (uid:number, o?:object) => void,
 *   onMove: (uids:number[], targetUid:number, where:'before'|'after') => void,
 *   onChecked: (n:number) => void,
 *   onBulkEdit: () => void,
 *   onOrderMode: (on:boolean) => void,
 * }} hooks
 */
export function createList(el, { onSelect, onMove, onChecked, onBulkEdit, onOrderMode }) {
    const p = prefs();
    const ui = { filter: 'all', q: '', sort: p.sort || 'custom', sel: null, checked: new Set(), lastCb: null };
    el.innerHTML = `
        <div class="lbw-list-tools">
            <div class="lbw-list-line">
                <input type="search" class="lbw-in lbw-search" placeholder="${tr('Поиск: название, ключи, текст')}" aria-label="${tr('Поиск по записям')}">
                <lbw-select class="lbw-in lbw-sort" aria-label="${tr('Сортировка')}">${SORTS.map(s => `<option value="${s.v}">${s.l}</option>`).join('')}</lbw-select>
            </div>
            <div class="lbw-chips"></div>
            <label class="lbw-om" title="${tr('Когда включено, order пересчитывается сам (1000, 999, …) при перетаскивании и переносе, и порядок абзацев в промпте совпадает со списком')}"><input type="checkbox" class="lbw-om-cb">${tr('order по месту в списке')}</label>
        </div>
        <div class="lbw-rows" tabindex="0" aria-label="${tr('Записи лорбука')}"></div>
        <div class="lbw-bulkbar" hidden>
            <b class="lbw-bulk-n"></b><span class="lbw-sp"></span>
            <button type="button" class="lbw-btn" data-act="bulk-edit">${tr('Править выбранные')}</button>
            <button type="button" class="lbw-btn" data-act="bulk-clear" title="${tr('Снять выделение (Esc)')}">${tr('Снять')}</button>
        </div>`;
    const $search = el.querySelector('.lbw-search');
    const $sort = el.querySelector('.lbw-sort');
    const $chips = el.querySelector('.lbw-chips');
    const $rows = el.querySelector('.lbw-rows');
    const $bar = el.querySelector('.lbw-bulkbar');
    const $om = el.querySelector('.lbw-om-cb');
    $sort.value = ui.sort;

    const collapsed = () => {
        const key = store.name || '';
        p.collapsed[key] ??= [];
        return p.collapsed[key];
    };
    // Touch screens reorder with the ↑↓ buttons; a draggable row there only adds a long-press drag ghost.
    const touch = matchMedia('(hover: none), (pointer: coarse)').matches;
    const canDrag = () => ui.sort === 'custom' && !touch;

    // Lower-cased search text per entry, rebuilt only when the title, keys or text change.
    const hayCache = new Map();
    function haystack(e) {
        const c = hayCache.get(e.uid);
        if (c && c.t === e.comment && c.k === e.key && c.x === e.content) return c.h;
        const h = (String(e.comment || '') + '\n' + (e.key || []).map(keyWordForm).join(' ') + '\n' + (e.key || []).join(' ') + '\n' + String(e.content || '')).toLowerCase();
        hayCache.set(e.uid, { t: e.comment, k: e.key, x: e.content, h });
        return h;
    }

    function passes(e, f) {
        if (!f.f(e)) return false;
        if (!ui.q) return true;
        return haystack(e).includes(ui.q);
    }

    function renderChips() {
        const all = entries().filter(e => !isSeparator(e));
        $chips.innerHTML = FILTERS.map(f => {
            const n = all.filter(f.f).length;
            if (f.id !== 'all' && f.id !== ui.filter && !n) return '';
            return `<button type="button" class="lbw-chip${ui.filter === f.id ? ' lbw-on' : ''}" data-f="${f.id}">${f.l}<b>${n}</b></button>`;
        }).join('');
    }

    function renderBar() {
        // drop uids that no longer exist
        for (const u of ui.checked) if (!store.data?.entries?.[u]) ui.checked.delete(u);
        const n = ui.checked.size;
        $bar.hidden = n === 0;
        el.querySelector('.lbw-bulk-n').textContent = tr('Выбрано {0} {1}', n, plural(n, 'запись', 'записи', 'записей'));
        onChecked(n);
    }

    function render() {
        if (!store.data) { $rows.innerHTML = `<div class="lbw-empty">${tr('Выбери лорбук в строке выше или создай новый.')}</div>`; $chips.innerHTML = ''; renderBar(); return; }
        renderChips();
        $om.checked = orderFollowsPosition();
        const sorted = sortEntries(entries(), ui.sort);
        const foldersOn = foldersActive(sorted);
        const drag = canDrag();
        // Every entry gets a row. What the search, the filter chips and collapsed folders hide is decided by
        // applyFilter(), so typing in the search box toggles classes instead of rebuilding the list.
        let h = '';
        for (const e of sorted) {
            if (foldersOn && isSeparator(e)) {
                h += `<div class="lbw-fold${ui.sel === e.uid ? ' lbw-sel' : ''}" data-fold="${esc(e.uid)}"${drag ? ' draggable="true"' : ''}>`
                    + `<button type="button" class="lbw-fold-c" title="${tr('Свернуть или развернуть')}">▾</button>`
                    + `<input type="checkbox" class="lbw-fold-cb" aria-label="${tr('Выделить все записи папки')}">`
                    + `<span class="lbw-fold-n" title="${tr('Открыть запись-разделитель')}${drag ? tr('. Потяни, чтобы переставить папку целиком') : ''}">${esc(folderName(e))}</span>`
                    + '<span class="lbw-fold-m"></span></div>';
            } else h += rowHTML(e, { selected: ui.sel === e.uid, checked: ui.checked.has(e.uid), drag });
        }
        $rows.innerHTML = h + '<div class="lbw-empty lbw-none" hidden></div>';
        applyFilter();
        renderBar();
    }

    const foldersActive = sorted => !!SORTS.find(s => s.v === ui.sort)?.folders && sorted.some(isSeparator);

    /**
     * Shows and hides rows for the current search, filter chip and collapsed folders, and rewrites the folder
     * headers (counts, tokens, arrow). Works on the rows already in the list.
     */
    function applyFilter() {
        if (!store.data) return;
        const f = FILTERS.find(x => x.id === ui.filter) || FILTERS[0];
        const filtering = !!ui.q || ui.filter !== 'all';
        const col = new Set(collapsed().map(String));
        let fold = null, total = 0, shown = 0, texts = [], anything = false;
        const closeFold = () => {
            if (!fold) return;
            const isCol = !filtering && col.has(fold.dataset.fold);
            const gone = filtering && !shown;
            fold.classList.toggle('lbw-fx', gone);
            fold.classList.toggle('lbw-col', isCol);
            fold.querySelector('.lbw-fold-c').textContent = isCol ? '▸' : '▾';
            fold.querySelector('.lbw-fold-cb').disabled = !shown;
            fold.querySelector('.lbw-fold-m').textContent = `${filtering ? shown + '/' : ''}${total} · ${tokLabel(tokenSum(texts))}`;
            if (!gone) anything = true;
        };
        for (const n of $rows.children) {
            if (n.classList.contains('lbw-fold')) { closeFold(); fold = n; total = 0; shown = 0; texts = []; continue; }
            if (!n.classList.contains('lbw-row')) continue;
            const e = store.data.entries[n.dataset.uid];
            const ok = !!e && passes(e, f);
            n.classList.toggle('lbw-fx', !ok);
            n.hidden = !!fold && !filtering && col.has(fold.dataset.fold);
            total++;
            if (e) texts.push(e.content);
            if (ok) { shown++; anything = true; }
        }
        closeFold();
        const none = $rows.querySelector('.lbw-none');
        if (none) {
            none.hidden = anything;
            none.textContent = filtering ? tr('Ничего не нашлось') : tr('В лорбуке пока нет записей');
        }
        syncFoldChecks();
    }

    /**
     * The order changed (a step button, drag and drop, a folder move): put the existing rows into the new order
     * instead of rebuilding all of them.
     */
    function reorder() {
        if (!store.data) { render(); return; }
        const sorted = sortEntries(entries(), ui.sort);
        const foldersOn = foldersActive(sorted);
        const have = new Map();
        for (const n of $rows.children) {
            if (n.classList.contains('lbw-fold')) have.set('f' + n.dataset.fold, n);
            else if (n.classList.contains('lbw-row')) have.set('r' + n.dataset.uid, n);
        }
        if (have.size !== sorted.length) { render(); return; }
        const want = [];
        for (const e of sorted) {
            const n = have.get((foldersOn && isSeparator(e) ? 'f' : 'r') + e.uid);
            if (!n) { render(); return; }
            want.push(n);
        }
        let cur = $rows.firstElementChild;
        for (const n of want) {
            if (n === cur) cur = cur.nextElementSibling;
            else $rows.insertBefore(n, cur);
        }
        $om.checked = orderFollowsPosition();
        applyFilter();
    }

    /** Rows of a folder: the rows after its header up to the next header. Rows the search hid are left out unless all=true. */
    function folderRows(fold, all = false) {
        const out = [];
        for (let n = fold.nextElementSibling; n && n.classList.contains('lbw-row'); n = n.nextElementSibling) {
            if (all || !n.classList.contains('lbw-fx')) out.push(n);
        }
        return out;
    }

    /** Exact token counts arrived: rewrite the labels in place instead of rebuilding the list. */
    function refreshTokens() {
        if (!store.data) return;
        for (const r of $rows.querySelectorAll('.lbw-row')) {
            const e = store.data.entries[r.dataset.uid];
            if (!e) continue;
            const tok = tokenInfo(e.content);
            r.querySelector('.lbw-row-m > span:last-child').textContent = tok.n ? tokLabel(tok) : '—';
        }
        const folds = $rows.querySelectorAll('.lbw-fold');
        if (!folds.length) return;
        const texts = new Map();   // separator uid -> contents of its folder (unfiltered, like render)
        let cur = null;
        for (const e of sortEntries(entries(), ui.sort)) {
            if (isSeparator(e)) { cur = []; texts.set(e.uid, cur); }
            else cur?.push(e.content);
        }
        for (const f of folds) {
            const m = f.querySelector('.lbw-fold-m');
            const head = m.textContent.slice(0, m.textContent.lastIndexOf('·') + 1);
            m.textContent = `${head} ${tokLabel(tokenSum(texts.get(Number(f.dataset.fold)) || []))}`;
        }
    }

    /** Folder checkboxes follow their rows (all checked → checked). */
    function syncFoldChecks() {
        for (const f of $rows.querySelectorAll('.lbw-fold')) {
            const rows = folderRows(f);
            f.querySelector('.lbw-fold-cb').checked = rows.length > 0 && rows.every(r => ui.checked.has(Number(r.dataset.uid)));
        }
    }

    function updateRow(uid) {
        const e = store.data?.entries?.[uid];
        const old = $rows.querySelector(`.lbw-row[data-uid="${uid}"]`);
        if (!e) { old?.remove(); return; }
        if (!old) {
            // a folder header: only its name can change here
            const name = $rows.querySelector(`.lbw-fold[data-fold="${uid}"] .lbw-fold-n`);
            if (name) name.textContent = folderName(e);
            return;
        }
        const hidden = old.hidden, fx = old.classList.contains('lbw-fx');
        old.outerHTML = rowHTML(e, { selected: ui.sel === e.uid, checked: ui.checked.has(e.uid), drag: canDrag() });
        const row = $rows.querySelector(`.lbw-row[data-uid="${uid}"]`);
        row.hidden = hidden;
        row.classList.toggle('lbw-fx', fx);
    }

    function setSelected(uid, { scroll = false } = {}) {
        ui.sel = uid;
        $rows.querySelectorAll('.lbw-sel').forEach(x => x.classList.remove('lbw-sel'));
        const row = $rows.querySelector(`.lbw-row[data-uid="${uid}"], .lbw-fold[data-fold="${uid}"]`);
        if (row) {
            row.classList.add('lbw-sel');
            if (scroll) {
                row.scrollIntoView({ block: 'nearest' });
                // Rows off screen use estimated heights (content-visibility); correct once they are laid out.
                requestAnimationFrame(() => { if (row.isConnected) row.scrollIntoView({ block: 'nearest' }); });
            }
        }
    }

    /** Makes sure the entry is visible: clears filters that hide it and expands its folder. */
    function reveal(uid) {
        const e = store.data?.entries?.[uid];
        if (!e) return;
        const f = FILTERS.find(x => x.id === ui.filter) || FILTERS[0];
        let changed = false;
        if (!passes(e, f)) { ui.filter = 'all'; ui.q = ''; $search.value = ''; changed = true; }
        const sorted = sortEntries(entries(), ui.sort);
        let sep = null;
        for (const x of sorted) { if (isSeparator(x)) sep = x; if (x.uid === e.uid) break; }
        if (sep && sep.uid !== e.uid) {
            const c = collapsed();
            const i = c.map(String).indexOf(String(sep.uid));
            if (i >= 0) { c.splice(i, 1); savePrefs(); changed = true; }
        }
        // The list is rebuilt only when the entry has no row yet; otherwise showing it is a matter of classes.
        if (!$rows.querySelector(`.lbw-row[data-uid="${uid}"], .lbw-fold[data-fold="${uid}"]`)) render();
        else if (changed) { renderChips(); applyFilter(); }
        setSelected(uid, { scroll: true });
    }

    // ---------- selection checkboxes ----------
    function setChecked(uid, on) {
        if (on) ui.checked.add(uid); else ui.checked.delete(uid);
        const r = $rows.querySelector(`.lbw-row[data-uid="${uid}"]`);
        if (r) { r.classList.toggle('lbw-checked', on); r.querySelector('.lbw-cb').checked = on; }
    }
    function clearChecked() {
        ui.checked.clear();
        render();
    }

    // ---------- events ----------
    let qTimer = 0;
    $search.addEventListener('input', () => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => { ui.q = $search.value.trim().toLowerCase(); applyFilter(); }, 80);
    });
    $sort.addEventListener('change', () => { ui.sort = $sort.value; p.sort = ui.sort; savePrefs(); render(); setSelected(ui.sel, { scroll: true }); });
    $chips.addEventListener('click', ev => {
        const b = ev.target.closest('.lbw-chip');
        if (!b) return;
        ui.filter = b.dataset.f;
        renderChips();
        applyFilter();
    });
    $om.addEventListener('change', () => { onOrderMode($om.checked); });
    $bar.addEventListener('click', ev => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (act === 'bulk-edit') onBulkEdit();
        if (act === 'bulk-clear') clearChecked();
    });
    $rows.addEventListener('click', ev => {
        const cb = ev.target.closest('.lbw-cb');
        if (cb) {
            const uid = Number(cb.closest('.lbw-row').dataset.uid);
            if (ev.shiftKey && ui.lastCb != null) {
                const rows = [...$rows.querySelectorAll('.lbw-row:not([hidden]):not(.lbw-fx)')].map(r => Number(r.dataset.uid));
                const a = rows.indexOf(ui.lastCb), b = rows.indexOf(uid);
                if (a >= 0 && b >= 0) {
                    const [lo, hi] = a < b ? [a, b] : [b, a];
                    for (const u of rows.slice(lo, hi + 1)) setChecked(u, cb.checked);
                }
            } else setChecked(uid, cb.checked);
            ui.lastCb = uid;
            syncFoldChecks();
            renderBar();
            return;
        }
        const fold = ev.target.closest('.lbw-fold');
        if (fold) {
            const uid = Number(fold.dataset.fold);
            if (ev.target.closest('.lbw-fold-cb')) {
                const on = ev.target.checked;
                for (const r of folderRows(fold)) setChecked(Number(r.dataset.uid), on);
                syncFoldChecks();
                renderBar();
                return;
            }
            if (ev.target.closest('.lbw-fold-c')) {
                const c = collapsed();
                const i = c.map(String).indexOf(String(uid));
                const open = i >= 0;
                if (open) c.splice(i, 1); else c.push(uid);
                savePrefs();
                fold.classList.toggle('lbw-col', !open);
                fold.querySelector('.lbw-fold-c').textContent = open ? '▾' : '▸';
                for (const r of folderRows(fold, true)) r.hidden = !open;
                return;
            }
            onSelect(uid);
            return;
        }
        const row = ev.target.closest('.lbw-row');
        if (row) onSelect(Number(row.dataset.uid));
    });
    $rows.addEventListener('keydown', ev => {
        if (ev.key === 'Escape' && ui.checked.size) { ev.preventDefault(); clearChecked(); return; }
        if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
        ev.preventDefault();
        const rows = [...$rows.querySelectorAll('.lbw-row:not([hidden]):not(.lbw-fx), .lbw-fold:not(.lbw-fx)')];
        const i = rows.findIndex(r => r.classList.contains('lbw-sel'));
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
        if (next) onSelect(Number(next.dataset.uid ?? next.dataset.fold), { keepFocus: true });
    });

    // ---------- drag & drop (custom order only) ----------
    let drag = null;
    let mark = null;
    const clearMark = () => { if (mark) mark.classList.remove('lbw-drop-before', 'lbw-drop-after'); mark = null; };

    $rows.addEventListener('dragstart', ev => {
        const item = ev.target.closest('.lbw-row, .lbw-fold');
        if (!item || !canDrag()) { ev.preventDefault(); return; }
        let uids;
        if (item.classList.contains('lbw-fold')) {
            const sepUid = Number(item.dataset.fold);
            const sorted = sortEntries(entries(), 'custom');
            const i = sorted.findIndex(x => x.uid === sepUid);
            uids = [sepUid];
            for (let j = i + 1; j < sorted.length && !isSeparator(sorted[j]); j++) uids.push(sorted[j].uid);
        } else {
            const uid = Number(item.dataset.uid);
            uids = ui.checked.has(uid) ? [...ui.checked] : [uid];
        }
        drag = { uids, el: item };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', uids.join(','));
        item.classList.add('lbw-dragging');
    });
    $rows.addEventListener('dragover', ev => {
        if (!drag) return;
        const t = ev.target.closest('.lbw-row, .lbw-fold');
        if (!t) return;
        const uid = Number(t.dataset.uid ?? t.dataset.fold);
        if (drag.uids.includes(uid)) { clearMark(); return; }
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        const r = t.getBoundingClientRect();
        const where = ev.clientY < r.top + r.height / 2 ? 'before' : 'after';
        if (mark !== t || !t.classList.contains('lbw-drop-' + where)) {
            clearMark();
            mark = t;
            t.classList.add('lbw-drop-' + where);
        }
    });
    $rows.addEventListener('dragleave', ev => {
        if (mark && !$rows.contains(ev.relatedTarget)) clearMark();
    });
    $rows.addEventListener('drop', ev => {
        if (!drag || !mark) return;
        ev.preventDefault();
        const uid = Number(mark.dataset.uid ?? mark.dataset.fold);
        const where = mark.classList.contains('lbw-drop-before') ? 'before' : 'after';
        const uids = drag.uids;
        clearMark();
        onMove(uids, uid, where);
    });
    $rows.addEventListener('dragend', () => {
        drag?.el?.classList.remove('lbw-dragging');
        drag = null;
        clearMark();
    });

    return {
        render, reorder, updateRow, setSelected, reveal, refreshTokens,
        get sel() { return ui.sel; },
        get sortMode() { return ui.sort; },
        get checked() { return [...ui.checked]; },
        clearChecked,
        focusSearch: () => $search.focus(),
        resetForBook() { hayCache.clear(); ui.q = ''; ui.filter = 'all'; $search.value = ''; ui.sel = null; ui.checked.clear(); ui.lastCb = null; },
        visibleOrder: () => sortEntries(entries(), ui.sort),
    };
}
