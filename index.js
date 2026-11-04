import './src/select.js';
import { world_names, showWorldEditor, createWorldInfoEntry, reloadEditor } from '../../../world-info.js';
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { store, onStore, openBook, flush, getEntry, entries, setField, markDirty } from './src/store.js';
import { createList } from './src/list.js';
import { createEditor } from './src/editor.js';
import { createTester } from './src/tester.js';
import { checkBook, bookIssues } from './src/check.js';
import { createCheckPane } from './src/checkpane.js';
import { insertAfter, inheritSettings, moveEntries, renumberOrders, setOrderMode, looksOrdered, orderFollowsPosition } from './src/order.js';
import { createBulk } from './src/bulk.js';
import { tokenSum, requestTokens, onTokens, forgetQueue } from './src/tokens.js';
import { esc, tokLabel, isSeparator, plural, prefs, savePrefs, debounce } from './src/util.js';
import { tr } from './src/i18n.js';

const MODULE = 'lorebookWorkbench';
const settings = () => (extension_settings[MODULE] ??= { enabled: true });

let slot, host, shadow, root, $wi, list, editor, tester, checkPane, bulk;
let bulkOpen = false;
let orderHintShown = false;
let tab = 'list';
let pendingSelect = null;
let nativeStale = false;
let nativeShown = null;

function rootHTML() {
    return `
    <div class="lbw-head">
        <div class="lbw-tabs" role="tablist">
            <button type="button" role="tab" data-tab="list" class="lbw-on">${tr('Записи')}</button>
            <button type="button" role="tab" data-tab="test">${tr('Тестер')}</button>
            <button type="button" role="tab" data-tab="check" title="${tr('Проверить, все ли записи могут сработать')}">${tr('Проверка')}<b class="lbw-tab-n"></b></button>
        </div>
        <span class="lbw-stats"></span>
        <span class="lbw-save"></span>
        <span class="lbw-sp"></span>
        <button type="button" class="lbw-btn" data-act="new" title="${tr('Новая запись после выбранной, с её настройками позиции и рекурсии')}">${tr('+ Запись')}</button>
        <button type="button" class="lbw-btn" data-act="top" title="${tr('Показать активные лорбуки и глобальные настройки WI')}"><span class="lbw-long">${tr('Активные и настройки')}</span><span class="lbw-short">⚙ WI</span></button>
    </div>
    <div class="lbw-main" data-pane="list">
        <aside class="lbw-list"></aside>
        <div class="lbw-split" title="${tr('Потяни, чтобы изменить ширину списка')}"></div>
        <section class="lbw-editor"></section>
        <section class="lbw-bulk" hidden></section>
    </div>
    <div class="lbw-test" data-pane="test" hidden></div>
    <div class="lbw-checkpane" data-pane="check" hidden></div>`;
}

// ---------- selection & refresh ----------
function showBulk(on) {
    bulkOpen = on;
    root.querySelector('.lbw-bulk').hidden = !on;
    root.querySelector('.lbw-editor').hidden = on;
    if (on) { bulk.render(); root.querySelector('.lbw-main').classList.add('lbw-show-ed'); }
}

function select(uid, { keepFocus = false } = {}) {
    if (bulkOpen) showBulk(false);
    if (uid == null || !getEntry(uid)) { editor.render(null); return; }
    list.setSelected(uid, { scroll: true });
    editor.render(uid);
    prefs().lastUid[store.name] = uid;
    savePrefs();
    root.querySelector('.lbw-main').classList.add('lbw-show-ed');
    if (keepFocus) root.querySelector('.lbw-rows')?.focus();
}

const updateStats = debounce(() => {
    const el = root.querySelector('.lbw-stats');
    if (!store.data) { el.textContent = ''; return; }
    const all = entries();
    const seps = all.filter(isSeparator).length;
    const n = all.length - seps;
    const tok = tokenSum(all.map(e => e.content));
    el.textContent = `${n} ${plural(n, 'запись', 'записи', 'записей')}${seps ? ` · ${seps} ${plural(seps, 'папка', 'папки', 'папок')}` : ''} · ${tokLabel(tok)} ${tr('ток.')}`;
}, 150);

const changedRows = new Set();
const flushRows = debounce(() => { changedRows.forEach(u => list.updateRow(u)); changedRows.clear(); }, 120);
function onChanged(uid) { changedRows.add(uid); flushRows(); updateStats(); recomputeIssues(); }
function onStructure(selectUid) {
    bookIssues.map = store.data ? checkBook(entries()) : new Map();
    updateBadge();
    list.render();
    updateStats();
    if (selectUid != null && getEntry(selectUid)) { list.reveal(selectUid); editor.render(selectUid); }
    else editor.render(list.sel);
}

// ---------- "will it fire?" check ----------
function updateBadge() {
    const b = root.querySelector('.lbw-tab-n');
    let err = 0;
    for (const issues of bookIssues.map.values()) if (issues.some(i => i.sev === 'error')) err++;
    b.textContent = err ? String(err) : '';
    b.className = 'lbw-tab-n' + (err ? ' lbw-bad' : '');
    b.title = err ? tr('Записей с ошибками: {0}', err) : '';
    if (tab === 'check') checkPane.render();
}

const recomputeIssues = debounce(() => {
    const prev = bookIssues.map;
    const next = store.data ? checkBook(entries()) : new Map();
    bookIssues.map = next;
    const lvl = m => m ? (m.some(i => i.sev === 'error') ? 'e' : 'w') : '';
    for (const u of new Set([...prev.keys(), ...next.keys()])) {
        if (lvl(prev.get(u)) !== lvl(next.get(u))) list.updateRow(u);
    }
    updateBadge();
}, 400);

function showSaveState(s) {
    const el = root?.querySelector('.lbw-save');
    if (!el) return;
    const map = { idle: [tr('Сохранено'), ''], pending: [tr('Есть правки…'), 'lbw-pending'], saving: [tr('Сохраняю…'), 'lbw-pending'], error: [tr('Не сохранено'), 'lbw-error'] };
    const [t, c] = map[s] || map.idle;
    el.textContent = store.name ? t : '';
    el.className = 'lbw-save ' + c;
}

function onBookLoaded() {
    if (bulkOpen) showBulk(false);
    bookIssues.map = store.data ? checkBook(entries()) : new Map();
    updateBadge();
    list.resetForBook();
    list.render();
    updateStats();
    showSaveState(store.state);
    forgetQueue();
    if (store.data) requestTokens(entries().map(e => e.content));
    if (!store.data) { editor.render(null); return; }
    const want = pendingSelect ?? prefs().lastUid[store.name];
    pendingSelect = null;
    const first = list.visibleOrder()[0];
    const uid = want != null && getEntry(want) ? want : first?.uid;
    if (uid != null) { list.reveal(uid); editor.render(uid); prefs().lastUid[store.name] = uid; }
    else editor.render(null);
    if (tab === 'test') tester.run();
}

// ---------- actions ----------
function newEntry() {
    if (!store.data) { toastr.info(tr('Сначала выбери лорбук')); return; }
    const ref = getEntry(list.sel);
    const follow = orderFollowsPosition();
    const e = createWorldInfoEntry(store.name, store.data);
    if (!e) return;
    let from = ref;
    if (ref && isSeparator(ref)) {
        const order = list.visibleOrder();
        const i = order.findIndex(x => x.uid === ref.uid);
        from = order.slice(i + 1).find(x => x.uid !== e.uid) || null;
        if (from && isSeparator(from)) from = null;
    }
    inheritSettings(e, from);
    insertAfter(e, ref, { renumber: follow });
    markDirty(e.uid);
    tabTo('list');
    onStructure(e.uid);
    editor.focusTitle();
}

function addKeyFromTester(rx) {
    const e = getEntry(editor.uid);
    if (!e) { toastr.info(tr('Сначала открой запись на вкладке «Записи»')); return; }
    const arr = Array.isArray(e.key) ? [...e.key] : [];
    if (arr.includes(rx)) { toastr.info(tr('Этот ключ уже есть в записи')); return; }
    arr.push(rx);
    setField(e, 'key', arr);
    onChanged(e.uid);
    toastr.success(tr('Ключ добавлен в «{0}»', e.comment || 'UID ' + e.uid));
    tester.run();
}

function openFromTester(world, uid) {
    if (world === store.name) { tabTo('list'); list.reveal(uid); select(uid); return; }
    const idx = world_names.indexOf(world);
    if (idx < 0) return;
    pendingSelect = uid;
    tabTo('list');
    $('#world_editor_select').val(idx).trigger('change');
}

function tabTo(t) {
    tab = t;
    root.querySelectorAll('.lbw-tabs button').forEach(b => b.classList.toggle('lbw-on', b.dataset.tab === t));
    root.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== t; });
    if (t === 'test') tester.run();
    if (t === 'check') checkPane.render();
}

// ---------- native integration ----------
function currentNativeBook() {
    const idx = $('#world_editor_select').val();
    return idx === '' || idx == null ? null : world_names?.[Number(idx)] ?? null;
}

async function syncFromNative() {
    await openBook(currentNativeBook());
}

/**
 * On every book switch SillyTavern rebuilds its own entry list, which the extension hides anyway:
 * ~130 ms on a fast PC, around a second on a phone. While the extension is on, skip that render;
 * the native book buttons get their book loaded on demand (guardNativeButtons).
 */
function muteNativeBookSwitch() {
    const el = document.getElementById('world_editor_select');
    const handlers = $._data(el, 'events')?.change || [];
    for (const h of handlers) {
        if (h.lbwWrapped || !String(h.handler).includes('showWorldEditor')) continue;
        const orig = h.handler;
        h.handler = function (...args) {
            if (settings().enabled) return;
            nativeShown = currentNativeBook();
            return orig.apply(this, args);
        };
        h.lbwWrapped = true;
    }
}

/** Native book buttons act on the book the native editor has loaded; load ours (with fresh edits) before they run. */
function guardNativeButtons() {
    for (const id of ['world_popup_export', 'world_popup_name_button', 'world_duplicate', 'world_popup_delete']) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.addEventListener('click', async ev => {
            if (!settings().enabled || ev.lbwPass || !store.name) return;
            if (nativeShown === store.name && !store.dirty.size && !nativeStale) return;
            ev.stopImmediatePropagation();
            ev.preventDefault();
            await flush();
            await showWorldEditor(store.name);
            nativeShown = store.name;
            nativeStale = false;
            const again = new MouseEvent('click', { bubbles: true, cancelable: true });
            again.lbwPass = true;
            btn.dispatchEvent(again);
        }, true);
    }
}

function apply() {
    const on = !!settings().enabled;
    $wi.toggleClass('lbw-on', on);
    $wi.toggleClass('lbw-show-top', on && !!prefs().showTop);
    slot.hidden = !on;
    $('#lbw-toggle').toggleClass('lbw-on', on).attr('title', on ? tr('SLAYlorebooks включён. Нажми, чтобы вернуть родной список записей') : tr('Включить SLAYlorebooks'));
    $('#lbw_enabled').prop('checked', on);
    if (on) syncFromNative();
    else flush().then(() => {
        const n = currentNativeBook();
        // Let go of the book once it is saved, so a later retry can never overwrite native edits.
        if (!store.dirty.size) closeBook();
        else toastr.warning(tr('SLAYlorebooks: правки ещё не сохранены, попробую ещё раз через 5 секунд'));
        if (n) reloadEditor(n, true);
    });
}

function setEnabled(on) {
    settings().enabled = on;
    saveSettingsDebounced();
    apply();
}

function initSplitter() {
    const main = root.querySelector('.lbw-main');
    const split = root.querySelector('.lbw-split');
    const p = prefs();
    if (p.listW) main.style.setProperty('--lbw-list-w', p.listW + 'px');
    split.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        split.setPointerCapture(ev.pointerId);
        const left = main.getBoundingClientRect().left;
        const move = e => {
            const w = Math.max(260, Math.min(main.clientWidth - 360, e.clientX - left));
            main.style.setProperty('--lbw-list-w', w + 'px');
            p.listW = Math.round(w);
        };
        const up = () => { split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); savePrefs(); };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
    });
}

// ---------- window width (PC) ----------
const WIN_SIZES = { wide: 1560, medium: 1200, narrow: 900 };
const WIN_MIN = 700;

/** A width dragged by hand wins over the size picked in the settings, until it is reset. */
function applyWinWidth() {
    const p = prefs();
    const w = p.winW || WIN_SIZES[p.winSize] || WIN_SIZES.wide;
    $wi[0].style.setProperty('--lbw-win-w', w + 'px');
    $wi.toggleClass('lbw-win-drag', p.winDrag !== false);
    $('#lbw_win_size').val(WIN_SIZES[p.winSize] ? p.winSize : 'wide');
    $('#lbw_win_drag').prop('checked', p.winDrag !== false);
    $('#lbw_win_reset').toggleClass('disabled', !p.winW);
}

function initWinEdges() {
    for (const side of ['left', 'right']) {
        const edge = document.createElement('div');
        edge.className = `lbw-win-edge lbw-win-edge-${side}`;
        edge.title = tr('Потяни, чтобы изменить ширину окна');
        edge.addEventListener('pointerdown', ev => {
            if (ev.button !== 0) return;
            ev.preventDefault();
            edge.setPointerCapture(ev.pointerId);
            const p = prefs();
            // The window stays centred, so both edges move and the width is twice the distance from the middle.
            const move = e => {
                const max = window.innerWidth - 16;
                p.winW = Math.round(Math.max(WIN_MIN, Math.min(max, Math.abs(e.clientX - window.innerWidth / 2) * 2)));
                $wi[0].style.setProperty('--lbw-win-w', p.winW + 'px');
            };
            const up = () => {
                edge.removeEventListener('pointermove', move);
                edge.removeEventListener('pointerup', up);
                edge.removeEventListener('pointercancel', up);
                savePrefs();
                applyWinWidth();
            };
            edge.addEventListener('pointermove', move);
            edge.addEventListener('pointerup', up);
            edge.addEventListener('pointercancel', up);
        });
        $wi[0].appendChild(edge);
    }
}

function addSettingsUI() {
    const html = `
    <div class="lbw-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SLAYlorebooks</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="lbw_enabled">
                    <input type="checkbox" id="lbw_enabled">
                    <span>${tr('Заменять список записей в панели лорбуков')}</span>
                </label>
                <small>${tr('То же самое переключает кнопка 🛠 рядом с выбором лорбука.')}</small>
                <hr>
                <label for="lbw_win_size">${tr('Ширина окна на ПК')}</label>
                <select id="lbw_win_size" class="text_pole">
                    <option value="wide">${tr('Широкое: до 1560 px')}</option>
                    <option value="medium">${tr('Среднее: до 1200 px')}</option>
                    <option value="narrow">${tr('Узкое: до 900 px')}</option>
                </select>
                <label class="checkbox_label" for="lbw_win_drag">
                    <input type="checkbox" id="lbw_win_drag">
                    <span>${tr('Менять ширину, потянув за край окна')}</span>
                </label>
                <div id="lbw_win_reset" class="menu_button menu_button_icon" role="button" tabindex="0">${tr('Сбросить размер окна')}</div>
                <small>${tr('Если потянуть окно, запоминается эта ширина. Сброс возвращает размер из списка.')}</small>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#lbw_enabled').on('change', function () { setEnabled(!!$(this).prop('checked')); });
    $('#lbw_win_size').on('change', function () {
        const p = prefs();
        p.winSize = String($(this).val());
        delete p.winW;
        savePrefs();
        applyWinWidth();
    });
    $('#lbw_win_drag').on('change', function () {
        prefs().winDrag = !!$(this).prop('checked');
        savePrefs();
        applyWinWidth();
    });
    $('#lbw_win_reset').on('click', () => {
        delete prefs().winW;
        savePrefs();
        applyWinWidth();
    });
}

function init() {
    $wi = $('#WorldInfo');
    const popup = document.getElementById('world_popup');
    if (!$wi.length || !popup) { console.warn('[SLAYlorebooks] World Info panel not found'); return; }

    // Tag the native toolbar rows so CSS can hide the entry tools while keeping the book row.
    $('#world_popup_new').parent().addClass('lbw-native-tools');
    const toggle = $('<div id="lbw-toggle" class="menu_button" role="button" tabindex="0">🛠</div>');
    toggle.on('click', () => setEnabled(!settings().enabled));
    $('#world_popup_delete').after(toggle);

    // The UI lives in a shadow root: SillyTavern's page has hundreds of :has() rules, so every DOM change
    // in the light DOM costs ~30 ms of style recalculation. Inside the shadow root the same change costs ~1 ms.
    // The host sits absolutely inside its own slot, so a change in the extension never makes the browser
    // re-lay out SillyTavern's page (as a plain flex item it cost ~17 ms per change).
    slot = document.createElement('div');
    slot.id = 'lbw-slot';
    popup.appendChild(slot);
    host = document.createElement('div');
    host.id = 'lbw-root';
    slot.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./ui.css', import.meta.url).href;
    shadow.appendChild(css);
    root = document.createElement('div');
    root.className = 'lbw-app';
    root.innerHTML = rootHTML();
    shadow.appendChild(root);
    // Keys typed in the extension must not reach SillyTavern's global hotkeys (swipes, send, etc.).
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, ev => ev.stopPropagation());

    list = createList(root.querySelector('.lbw-list'), {
        onSelect: (uid, o) => select(uid, o),
        onMove: (uids, target, where) => {
            const follow = orderFollowsPosition();
            if (!moveEntries(uids, target, where)) return;
            onStructure(list.sel);
            if (bulkOpen) bulk.render();
            if (!follow && !orderHintShown) {
                orderHintShown = true;
                toastr.info(tr('Порядок в списке поменялся, а order записей нет. Чтобы и в промпте было как в списке, включи «order по месту в списке».'), '', { timeOut: 8000 });
            }
        },
        onChecked: n => {
            if (!bulkOpen) return;
            if (n === 0) { showBulk(false); editor.render(list.sel); }
            else bulk.render();
        },
        onBulkEdit: () => showBulk(true),
        onOrderMode: async on => {
            if (!store.data) return;
            if (on) {
                if (!looksOrdered()) {
                    const n = entries().length;
                    const ok = await SillyTavern.getContext().Popup.show.confirm(tr('Пересчитать order по списку?'), tr('У всех {0} записей order станет 1000, 999, … сверху вниз, как в списке «Свой порядок». Порядок абзацев в промпте станет таким же. Тексты и ключи не меняются.', n));
                    if (!ok) { list.render(); return; }
                    setOrderMode('on');
                    renumberOrders();
                    toastr.success(tr('order пересчитан по списку'));
                } else setOrderMode('on');
            } else setOrderMode('off');
            onStructure(list.sel);
        },
    });
    editor = createEditor(root.querySelector('.lbw-editor'), {
        onChanged,
        onSelect: uid => { list.reveal(uid); select(uid); },
        onStructure,
        canReorder: () => list.sortMode === 'custom',
    });
    tester = createTester(root.querySelector('.lbw-test'), { onOpen: openFromTester, addKey: addKeyFromTester });
    bulk = createBulk(root.querySelector('.lbw-bulk'), {
        getChecked: () => list.checked,
        onDone: (label, n, { cleared = false } = {}) => {
            if (cleared) { list.clearChecked(); showBulk(false); }
            onStructure(cleared ? null : list.sel);
            if (bulkOpen) bulk.render();
            if (label) toastr.success(`${label}: ${n} ${plural(n, 'запись', 'записи', 'записей')}`);
        },
        onClose: () => { showBulk(false); editor.render(list.sel); },
        canReorder: () => list.sortMode === 'custom',
    });
    checkPane = createCheckPane(root.querySelector('.lbw-checkpane'), { onOpen: openFromTester });

    root.querySelector('.lbw-head').addEventListener('click', ev => {
        const t = ev.target.closest('[data-tab]');
        if (t) { tabTo(t.dataset.tab); return; }
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (act === 'new') newEntry();
        if (act === 'top') {
            const p = prefs();
            p.showTop = !p.showTop;
            savePrefs();
            $wi.toggleClass('lbw-show-top', p.showTop);
        }
    });

    // Exact token counts arrive in the background: refresh rows, folder totals and the header.
    const refreshTokens = debounce(() => { list.refreshTokens(); updateStats(); }, 250);
    onTokens(() => { if (store.data) refreshTokens(); });

    onStore((kind, payload) => {
        if (kind === 'book') onBookLoaded();
        else if (kind === 'state') { showSaveState(payload); if (payload === 'pending') nativeStale = true; }
        else if (kind === 'blocked') { $('#world_editor_select').val(world_names.indexOf(payload)); }
        else if (kind === 'external') {
            nativeStale = true;
            bookIssues.map = checkBook(entries());
            updateBadge();
            list.render();
            updateStats();
            const ed = root.querySelector('.lbw-editor');
            if (!ed.contains(shadow.activeElement)) editor.render();
        }
    });

    $('#world_editor_select').on('change', () => { if (settings().enabled) syncFromNative(); });
    nativeShown = currentNativeBook();
    muteNativeBookSwitch();
    guardNativeButtons();
    initSplitter();
    addSettingsUI();
    initWinEdges();
    applyWinWidth();
    // Edits within the 0.7 s debounce: send them now and ask the browser to confirm closing, since a fetch
    // started during unload can be dropped.
    window.addEventListener('beforeunload', ev => { if (store.dirty.size) { flush(); ev.preventDefault(); ev.returnValue = ''; } });
    apply();
    console.log('[SLAYlorebooks] loaded');
}

jQuery(() => {
    try { init(); } catch (e) { console.error('[SLAYlorebooks] init failed', e); toastr.error(tr('SLAYlorebooks не запустился, подробности в консоли')); }
});
