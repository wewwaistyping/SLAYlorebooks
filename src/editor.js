import {
    getWorldEntry,
    splitKeywordsAndRegexes,
    duplicateWorldInfoEntry,
    deleteWorldInfoEntry,
    deleteWIOriginalDataValue,
    world_info_recursive,
} from '../../../../world-info.js';
import { store, entries, getEntry, val, setField, setMode, setDisabled, setPosition, markDirty, fillMissing, flush } from './store.js';
import { esc, plural, isSeparator, folderName, POSITIONS, positionValue, prefs, savePrefs, debounce } from './util.js';
import { keyChipInner, entryMatches, buildKey, guessKeyType, typesForWord, canAutoRegex } from './keys.js';
import { mountBuilder } from './builder.js';
import { insertAfter, moveToFolder, orderFollowsPosition, moveStep } from './order.js';
import { askTarget, transferEntries } from './transfer.js';
import { keyIssueFor, issuesFor } from './check.js';
import { folderLayout } from './sort.js';
import { countNow } from './tokens.js';
import { tr } from './i18n.js';

// ---------- MemoryBooks: "regenerate this entry" ----------
// MemoryBooks puts its button into the rows of the native entry list, which this extension hides. The same
// action is offered here; the click is handed to MemoryBooks' own handler, so all of its checks and its
// approval window stay in charge.
const STMB_BTN = '.stmb-regenerate-entry';

/** MemoryBooks is loaded and new enough to regenerate (it listens for clicks on its button). */
function stmbReady() {
    try {
        const ev = window.jQuery?._data?.(document, 'events')?.click || [];
        return ev.some(h => h.selector === STMB_BTN);
    } catch { return false; }
}

/** 'memory' | 'sidePrompt' | null, by the marks MemoryBooks leaves on its entries. */
function stmbKind(e) {
    if (!e || Object.hasOwn(e, 'STMB_clipReview')) return null;
    const t = String(e.comment || '').trimEnd();
    if (Object.hasOwn(e, 'STMB_sidePromptRegeneration') || / \(STMB (SidePrompt|Plotpoints|Scoreboard|Tracker)\)$/.test(t)) return 'sidePrompt';
    return e.stmemorybooks === true ? 'memory' : null;
}

function stmbBtnHTML(e) {
    const kind = stmbKind(e);
    if (!kind || !stmbReady()) return '';
    // MemoryBooks can redo a side prompt only from a run it has saved in the entry
    const noRun = kind === 'sidePrompt' && !Object.hasOwn(e, 'STMB_sidePromptRegeneration');
    const tip = noRun ? tr('MemoryBooks: запусти этот side prompt один раз, тогда его можно будет перегенерировать.')
        : tr('MemoryBooks: сгенерировать замену для этой записи. Перед заменой покажет результат и спросит.');
    return `<button type="button" class="lbw-btn lbw-stmb" data-act="stmb" title="${tip}"${noRun ? ' disabled' : ''}>↻ <span class="lbw-long">${kind === 'sidePrompt' ? tr('Перегенерировать side prompt') : tr('Перегенерировать память')}</span><span class="lbw-short">MemoryBooks</span></button>`;
}

const LOGIC = [
    { v: 0, l: tr('И любой из них') },
    { v: 3, l: tr('И все сразу') },
    { v: 2, l: tr('НЕ любой из них') },
    { v: 1, l: tr('НЕ все сразу') },
];

/**
 * Right pane: one entry at a time. Edits go straight into store.data and are saved by the store.
 * @param {HTMLElement} el
 * @param {{ onChanged: (uid:number) => void, onSelect: (uid:number) => void, onStructure: (selectUid?:number) => void }} hooks
 */
export function createEditor(el, { onChanged, onSelect, onStructure, onReordered = onStructure, canReorder = () => true }) {
    const p = prefs();
    let uid = null;
    let builderOpen = false;
    let linksJob = 0;
    // Keys the "Аа→ regex" button made in this entry, per kind: regex → { w: the word, t: type, unsure, checked }.
    // Kept while the same entry is open, so a type can be changed and the whole step undone.
    let conv = { uid: null, key: null, keysecondary: null };
    let convOpen = null; // { kind, key } whose endings are shown
    const convOf = kind => (conv.uid === uid ? conv[kind] : null);

    const countTokens = debounce(async (text, target) => {
        try {
            const n = await countNow(text || '');
            if (target.isConnected) target.textContent = `${n} ${tr('ток.')}`;
        } catch { /* tokenizer unavailable */ }
    }, 700);

    function keysHTML(e, kind) {
        const arr = Array.isArray(e[kind]) ? e[kind] : [];
        const chips = arr.map((k, i) => {
            const bad = keyIssueFor(k, e);
            const cv = convOf(kind)?.get(k);
            const cls = (bad ? ` lbw-kc-${bad.sev}` : '')
                + (cv ? ' lbw-kc-conv' + (cv.unsure && !cv.checked ? ' lbw-kc-unsure' : '') + (convOpen?.kind === kind && convOpen.key === k ? ' lbw-kc-open' : '') : '');
            const tip = (bad ? `${bad.sev === 'error' ? '✖' : '⚠'} ${bad.msg}\n\n` : '') + `${k}\n\n${cv ? tr('Нажми, чтобы выбрать окончания') : tr('Нажми, чтобы изменить')}`;
            return `<span class="lbw-kc${cls}" data-i="${i}" title="${esc(tip)}">${bad ? `<b class="lbw-kc-flag">${bad.sev === 'error' ? '✖' : '⚠'}</b>` : ''}${keyChipInner(k, p.raw)}<button type="button" class="lbw-kc-x" title="${tr('Удалить ключ')}" aria-label="${tr('Удалить ключ')}">×</button></span>`;
        }).join('');
        const ph = kind === 'key' ? (arr.length ? tr('+ ключ') : tr('слово или /regex/, Enter')) : (arr.length ? tr('+ ключ') : tr('вторичные ключи, Enter'));
        return `<div class="lbw-keys" data-kind="${kind}" data-uid="${esc(e.uid)}">${chips}<input class="lbw-key-add" enterkeyhint="done" placeholder="${ph}" aria-label="${tr('Добавить ключ')}"></div>`;
    }

    const plainCount = (e, kind) => (Array.isArray(e[kind]) ? e[kind] : []).filter(canAutoRegex).length;

    function rxBtnHTML(e, kind) {
        return `<button type="button" class="lbw-tgl lbw-tgl-rx" data-act="rx-all" data-kind="${kind}" title="${tr('Сделать regex со склонениями из всех обычных ключей. Уже готовые regex не меняются.')}"${plainCount(e, kind) ? '' : ' hidden'}><b>Аа→</b> regex</button>`;
    }

    /** Endings picker and the "N keys became regex · undo" line under a key box. */
    function convHTML(e, kind) {
        const map = convOf(kind);
        if (!map) return '';
        const arr = Array.isArray(e[kind]) ? e[kind] : [];
        const live = [...map.keys()].filter(k => arr.includes(k));
        if (!live.length) return '';
        let h = '';
        if (convOpen?.kind === kind && live.includes(convOpen.key)) {
            const c = map.get(convOpen.key);
            h += `<div class="lbw-rx-pick"><span class="lbw-muted">${esc(c.w)}:</span>${typesForWord(c.w).map(t =>
                `<button type="button" class="lbw-rx-t${t.v === c.t ? ' lbw-on' : ''}" data-rxt="${t.v}" data-kind="${kind}">${esc(t.l)}</button>`).join('')}`
                + `<button type="button" class="lbw-rx-t lbw-rx-text" data-act="rx-text" data-kind="${kind}">${tr('править текстом')}</button></div>`;
        }
        const unsure = live.filter(k => map.get(k).unsure && !map.get(k).checked).length;
        const n = live.length;
        h += `<div class="lbw-rx-note"><span>${tr('{0} {1} regex', n, plural(n, 'ключ стал', 'ключа стали', 'ключей стали'))}</span>`
            + (unsure ? `<span class="lbw-rx-warn">● ${tr('проверь {0}: нажми на ключ', unsure)}</span>` : '')
            + `<button type="button" class="lbw-link" data-act="rx-undo" data-kind="${kind}">${tr('Вернуть как было')}</button></div>`;
        return h;
    }

    function refreshConv(e, kind) {
        const slot = el.querySelector(`.lbw-rx-slot[data-kind="${kind}"]`);
        if (slot) slot.innerHTML = convHTML(e, kind);
        const btn = el.querySelector(`[data-act="rx-all"][data-kind="${kind}"]`);
        if (btn) btn.hidden = !plainCount(e, kind);
    }

    function render(nextUid = uid) {
        const sameEntry = nextUid === uid;
        uid = nextUid;
        if (!sameEntry) { conv = { uid: null, key: null, keysecondary: null }; convOpen = null; }
        const e = uid == null ? null : getEntry(uid);
        if (!store.data) { el.innerHTML = `<div class="lbw-empty">${tr('Выбери лорбук в строке выше или создай новый.')}</div>`; return; }
        if (!e) { el.innerHTML = `<div class="lbw-empty">${tr('Выбери запись слева.')}</div>`; return; }
        const sep = isSeparator(e);
        const mode = e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'normal';
        const pos = positionValue(e);
        const isDepth = Number(e.position) === 4;
        const k2 = Array.isArray(e.keysecondary) ? e.keysecondary : [];
        // re-drawing the same entry keeps the place; another entry opens from its title
        const scrollTop = sameEntry ? el.scrollTop : 0;
        el.innerHTML = `
        <div class="lbw-ed">
            <div class="lbw-ed-top">
                <button type="button" class="lbw-btn lbw-back" data-act="back">${tr('← Список')}</button>
                <span class="lbw-ed-uid">UID ${esc(e.uid)}</span>
                <span class="lbw-sp"></span>
                ${folderSelectHTML(e)}
                <span class="lbw-step-group" role="group" aria-label="${tr('Сдвинуть')}">
                    <button type="button" class="lbw-btn lbw-step" data-act="up" title="${sep ? tr('Поднять папку целиком') : tr('Сдвинуть запись выше')}" aria-label="${tr('Выше')}">↑</button>
                    <button type="button" class="lbw-btn lbw-step" data-act="down" title="${sep ? tr('Опустить папку целиком') : tr('Сдвинуть запись ниже')}" aria-label="${tr('Ниже')}">↓</button>
                </span>
                ${stmbBtnHTML(e)}
                <button type="button" class="lbw-btn" data-act="transfer" title="${tr('Перенести или скопировать запись в другой лорбук')}">${tr('В лорбук…')}</button>
                <button type="button" class="lbw-btn" data-act="dup" title="${tr('Создать копию записи рядом')}">${tr('Дублировать')}</button>
                <button type="button" class="lbw-btn lbw-danger" data-act="del" title="${tr('Удалить запись')}">${tr('Удалить')}</button>
            </div>
            <input class="lbw-in lbw-title" data-f="comment" value="${esc(e.comment || '')}" placeholder="${tr('Название записи')}" aria-label="${tr('Название записи')}">
            <div class="lbw-hint lbw-sep-hint"${sep ? '' : ' hidden'}>${tr('Это разделитель: название начинается с «===», поэтому в списке он работает как папка для записей ниже.')}</div>
            <div class="lbw-ed-issues"></div>
            <div class="lbw-grid">
                <label>${tr('Режим')}<lbw-select class="lbw-in" data-f="mode">
                    <option value="constant"${mode === 'constant' ? ' selected' : ''}>${tr('🔵 Константа')}</option>
                    <option value="normal"${mode === 'normal' ? ' selected' : ''}>${tr('🟢 По ключам')}</option>
                    <option value="vectorized"${mode === 'vectorized' ? ' selected' : ''}>${tr('🔗 Векторы')}</option>
                </lbw-select></label>
                <label class="lbw-wide">${tr('Позиция')}<lbw-select class="lbw-in" data-f="position">${POSITIONS.map(o => `<option value="${o.v}"${o.v === pos ? ' selected' : ''}>${esc(o.l)}</option>`).join('')}</lbw-select></label>
                <label>${tr('Глубина')}<input class="lbw-in" type="number" min="0" data-f="depth" value="${esc(val(e, 'depth'))}"${isDepth ? '' : ' disabled'}></label>
                <label>${tr('Порядок')}<input class="lbw-in" type="number" data-f="order" value="${esc(val(e, 'order'))}"></label>
                <label>${tr('Шанс, %')}<input class="lbw-in" type="number" min="0" max="100" data-f="probability" value="${esc(val(e, 'probability'))}"></label>
                <label class="lbw-check"><input type="checkbox" data-f="enabled"${e.disable ? '' : ' checked'}>${tr('Включена')}</label>
            </div>
            ${Number(e.position) === 7 ? `<label class="lbw-outlet">${tr('Имя слота (outlet)')}<input class="lbw-in" data-f="outletName" value="${esc(e.outletName || '')}"></label>` : ''}
            <section class="lbw-sec">
                <div class="lbw-sec-h">${tr('Ключи')} <span class="lbw-cnt">${(e.key || []).length}</span><span class="lbw-sp"></span>
                    ${rxBtnHTML(e, 'key')}
                    <button type="button" class="lbw-tgl${p.raw ? ' lbw-on' : ''}" data-act="raw" title="${tr('Показывать ключи как они записаны в файле')}">regex</button>
                    <button type="button" class="lbw-tgl${builderOpen ? ' lbw-on' : ''}" data-act="builder">${tr('Конструктор')}</button>
                </div>
                ${keysHTML(e, 'key')}
                <div class="lbw-rx-slot" data-kind="key">${convHTML(e, 'key')}</div>
                <div class="lbw-builder-slot"${builderOpen ? '' : ' hidden'}></div>
            </section>
            <section class="lbw-sec">
                <div class="lbw-sec-h">${tr('Вторичные ключи')} <span class="lbw-cnt">${k2.length}</span><span class="lbw-sp"></span>
                    ${rxBtnHTML(e, 'keysecondary')}
                    <lbw-select class="lbw-in lbw-logic" data-f="selectiveLogic" aria-label="${tr('Логика вторичных ключей')}"${k2.length ? '' : ' disabled'}>${LOGIC.map(o => `<option value="${o.v}"${Number(val(e, 'selectiveLogic')) === o.v ? ' selected' : ''}>${o.l}</option>`).join('')}</lbw-select>
                </div>
                ${keysHTML(e, 'keysecondary')}
                <div class="lbw-rx-slot" data-kind="keysecondary">${convHTML(e, 'keysecondary')}</div>
            </section>
            <section class="lbw-sec lbw-sec-text">
                <div class="lbw-sec-h">${tr('Текст')} <span class="lbw-cnt lbw-tok">…</span></div>
                <textarea class="lbw-in lbw-content" data-f="content" aria-label="${tr('Текст записи')}" placeholder="${tr('Что модель должна знать')}">${esc(e.content || '')}</textarea>
            </section>
            <section class="lbw-sec">
                <div class="lbw-sec-h">${tr('Рекурсия')}</div>
                <div class="lbw-checks">
                    <label class="lbw-check"><input type="checkbox" data-f="preventRecursion"${e.preventRecursion ? ' checked' : ''}>${tr('Не запускать рекурсию')}</label>
                    <label class="lbw-check"><input type="checkbox" data-f="excludeRecursion"${e.excludeRecursion ? ' checked' : ''}>${tr('Не срабатывать от рекурсии')}</label>
                    <label class="lbw-check"><input type="checkbox" data-f="delayUntilRecursion"${e.delayUntilRecursion ? ' checked' : ''}>${tr('Только через рекурсию')}</label>
                </div>
                <div class="lbw-links"><span class="lbw-muted">${tr('Считаю связи…')}</span></div>
            </section>
            <button type="button" class="lbw-btn lbw-native-btn" data-act="native">${tr('Все настройки ST: группы, таймеры, фильтр персонажей, сканирование…')}</button>
        </div>`;
        el.scrollTop = scrollTop;
        refreshIssues();
        countTokens(e.content, el.querySelector('.lbw-tok'));
        if (builderOpen) mountBuilderHere();
        scheduleLinks();
    }

    /**
     * The entry moved, or became a folder header (or stopped being one): refresh the bits of the form that
     * depend on its place, without rebuilding the form and taking the focus away.
     */
    function patchPlace() {
        const e = getEntry(uid);
        const top = el.querySelector('.lbw-ed-top');
        if (!e || !top) return;
        const sep = isSeparator(e);
        top.querySelector('.lbw-folder')?.remove();
        const html = folderSelectHTML(e);
        if (html) top.querySelector('.lbw-step-group').insertAdjacentHTML('beforebegin', html);
        const hint = el.querySelector('.lbw-sep-hint');
        if (hint) hint.hidden = !sep;
        const up = top.querySelector('[data-act="up"]'), down = top.querySelector('[data-act="down"]');
        if (up) up.title = sep ? tr('Поднять папку целиком') : tr('Сдвинуть запись выше');
        if (down) down.title = sep ? tr('Опустить папку целиком') : tr('Сдвинуть запись ниже');
        const order = el.querySelector('[data-f="order"]');
        if (order && el.getRootNode().activeElement !== order) order.value = String(val(e, 'order'));
    }

    function mountBuilderHere() {
        const slot = el.querySelector('.lbw-builder-slot');
        if (!slot) return;
        mountBuilder(slot, {
            targets: [{ id: 'key', l: tr('В ключи') }, { id: 'keysecondary', l: tr('Во вторичные') }],
            excludeUid: () => uid,
            onAdd: (rx, kind) => {
                const e = getEntry(uid);
                if (!e) return;
                const arr = Array.isArray(e[kind]) ? [...e[kind]] : [];
                if (!arr.includes(rx)) arr.push(rx);
                setKeys(e, kind, arr);
            },
        }).focus();
    }

    // ---------- problems of this entry ----------
    function refreshIssues() {
        const box = el.querySelector('.lbw-ed-issues');
        const e = getEntry(uid);
        if (!box || !e) return;
        const issues = issuesFor(e, entries());
        box.hidden = !issues.length;
        if (!issues.length) { box.innerHTML = ''; return; }
        const hasErr = issues.some(i => i.sev === 'error');
        box.className = 'lbw-ed-issues ' + (hasErr ? 'lbw-ed-issues-error' : 'lbw-ed-issues-warn');
        box.innerHTML = `<div class="lbw-issues-head">${hasErr ? tr('✖ Здесь есть ошибка') : tr('⚠ Стоит проверить')}</div><ul class="lbw-issues">${issues.map(i =>
            `<li class="lbw-issue-${i.sev}"><span class="lbw-issue-ico">${i.sev === 'error' ? '✖' : '⚠'}</span><span>${esc(i.msg)}${i.key ? `<code class="lbw-issue-key">${esc(i.key.length > 120 ? i.key.slice(0, 120) + '…' : i.key)}</code>` : ''}</span></li>`).join('')}</ul>`;
    }

    // ---------- links ----------
    function scheduleLinks() {
        const job = ++linksJob;
        setTimeout(() => { if (job === linksJob) renderLinks(); }, 30);
    }

    function renderLinks() {
        const box = el.querySelector('.lbw-links');
        const e = getEntry(uid);
        if (!box || !e) return;
        const others = entries().filter(x => x.uid !== e.uid && !isSeparator(x));
        const text = '\x01' + (e.content || '');
        const out = e.content ? others.filter(x => !x.constant && entryMatches(x, text)) : [];
        const inn = (e.key || []).length ? others.filter(x => x.content && entryMatches(e, '\x01' + x.content)) : [];
        const rec = !!world_info_recursive;
        const outLive = x => rec && !e.preventRecursion && !x.excludeRecursion && !x.disable;
        const inLive = x => rec && !x.preventRecursion && !e.excludeRecursion && !x.disable && !e.disable;
        const chip = (x, live) => `<button type="button" class="lbw-lk${live ? ' lbw-live' : ' lbw-dead'}" data-go="${esc(x.uid)}" title="${live ? tr('подтянет рекурсией') : tr('упоминает, но не подтянет')}">${esc(x.comment || 'UID ' + x.uid)}</button>`;
        const nOutLive = out.filter(outLive).length;
        const nInLive = inn.filter(inLive).length;
        const notes = [];
        if (!rec) notes.push(tr('Рекурсия выключена в глобальных настройках WI, записи друг друга не подтягивают.'));
        else {
            if (out.length && e.preventRecursion) notes.push(tr('Стоит «Не запускать рекурсию», поэтому упомянутых записей ({0}) она не подтянет.', out.length));
            else if (out.length) notes.push(tr('Когда запись сработает, она подтянет {0} из {1}.', nOutLive, out.length));
            if (inn.length && e.excludeRecursion) notes.push(tr('Стоит «Не срабатывать от рекурсии»: упоминания в других записях её не включат.'));
            else if (inn.length) notes.push(tr('Подтянуть её рекурсией могут {0} из {1}.', nInLive, inn.length));
        }
        box.innerHTML = `
            <div class="lbw-lk-row"><span class="lbw-muted">${tr('Упоминает ({0}):', out.length)}</span>${out.length ? out.map(x => chip(x, outLive(x))).join('') : `<span class="lbw-muted">${tr('никого')}</span>`}</div>
            <div class="lbw-lk-row"><span class="lbw-muted">${tr('Упоминается в ({0}):', inn.length)}</span>${inn.length ? inn.map(x => chip(x, inLive(x))).join('') : `<span class="lbw-muted">${tr('нигде')}</span>`}</div>
            ${notes.length ? `<div class="lbw-hint">${notes.map(esc).join(' ')} ${tr('Пунктир: упоминает, но не подтянет.')}</div>` : ''}`;
    }

    // ---------- keys ----------
    function setKeys(e, kind, arr) {
        setField(e, kind, arr);
        if (kind === 'keysecondary' && arr.length && !e.selective) setField(e, 'selective', true);
        rerenderKeys(e, kind);
        refreshIssues();
        onChanged(e.uid);
        scheduleLinks();
    }

    function rerenderKeys(e, kind) {
        const box = el.querySelector(`.lbw-keys[data-kind="${kind}"]`);
        if (!box) return;
        // Only the chips that changed are replaced. Rebuilding the whole box would take away the chip the user
        // has just pressed (leaving a key field commits it first), and that click would be lost.
        const tmp = document.createElement('div');
        tmp.innerHTML = keysHTML(e, kind);
        const fresh = tmp.firstElementChild;
        const input = box.querySelector(':scope > .lbw-key-add');
        const old = [...box.querySelectorAll(':scope > .lbw-kc')];
        const next = [...fresh.querySelectorAll(':scope > .lbw-kc')];
        next.forEach((nc, i) => {
            const oc = old[i];
            if (oc && !oc.classList.contains('lbw-editing') && oc.outerHTML === nc.outerHTML) return;
            if (oc) oc.replaceWith(nc); else box.insertBefore(nc, input);
        });
        old.slice(next.length).forEach(c => c.remove());
        if (input) input.placeholder = fresh.querySelector('.lbw-key-add').placeholder;
        const sec = el.querySelector(`.lbw-keys[data-kind="${kind}"]`)?.closest('.lbw-sec');
        const cnt = sec?.querySelector('.lbw-cnt');
        if (cnt) cnt.textContent = String((e[kind] || []).length);
        if (kind === 'keysecondary') {
            const lg = el.querySelector('.lbw-logic');
            if (lg) lg.disabled = !(e.keysecondary || []).length;
        }
        refreshConv(e, kind);
    }

    // ---------- all plain keys → regex ----------
    function convertAll(e, kind) {
        const arr = Array.isArray(e[kind]) ? e[kind] : [];
        if (conv.uid !== uid) conv = { uid, key: null, keysecondary: null };
        const map = conv[kind] || new Map();
        const next = [];
        for (const k of arr) {
            if (!canAutoRegex(k)) { next.push(k); continue; }
            const w = k.trim();
            const g = guessKeyType(w);
            const rx = buildKey(w, g.t);
            if (!rx) { next.push(k); continue; }
            map.set(rx, { w, t: g.t, unsure: g.unsure, checked: false });
            next.push(rx);
        }
        conv[kind] = map;
        convOpen = null;
        setKeys(e, kind, [...new Set(next)]);
    }

    function setConvType(e, kind, t) {
        const map = convOf(kind);
        const old = convOpen?.key;
        const c = map?.get(old);
        if (!c) return;
        const rx = buildKey(c.w, t);
        map.delete(old);
        map.set(rx, { ...c, t, checked: true });
        convOpen = null;
        setKeys(e, kind, [...new Set(e[kind].map(k => (k === old ? rx : k)))]);
    }

    function undoConv(e, kind) {
        const map = convOf(kind);
        if (!map) return;
        const arr = e[kind].map(k => (map.has(k) ? map.get(k).w : k));
        conv[kind] = null;
        convOpen = null;
        setKeys(e, kind, [...new Set(arr)]);
    }

    function startChipEdit(chip) {
        const e = getEntry(uid);
        const kind = chip.closest('.lbw-keys').dataset.kind;
        const i = Number(chip.dataset.i);
        const old = e[kind][i];
        chip.classList.add('lbw-editing');
        chip.innerHTML = `<input class="lbw-kc-edit" value="${esc(old)}" aria-label="${tr('Изменить ключ')}">`;
        const input = chip.querySelector('input');
        input.style.width = Math.min(Math.max(old.length, 8), 90) + 'ch';
        input.focus();
        input.select();
        let done = false;
        const commit = save => {
            if (done) return;
            done = true;
            if (!save) { rerenderKeys(e, kind); return; }
            const next = splitKeywordsAndRegexes(input.value);
            const arr = [...e[kind]];
            arr.splice(i, 1, ...next);
            if (JSON.stringify(arr) === JSON.stringify(e[kind])) rerenderKeys(e, kind);
            else setKeys(e, kind, arr);
        };
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
            if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); commit(false); }
        });
        input.addEventListener('blur', () => commit(true));
    }

    // ---------- events ----------
    el.addEventListener('click', async ev => {
        const e = getEntry(uid);
        if (!e) return;
        const x = ev.target.closest('.lbw-kc-x');
        if (x) {
            const chip = x.closest('.lbw-kc');
            const kind = chip.closest('.lbw-keys').dataset.kind;
            const arr = [...e[kind]];
            arr.splice(Number(chip.dataset.i), 1);
            setKeys(e, kind, arr);
            return;
        }
        const rxt = ev.target.closest('[data-rxt]');
        if (rxt) { setConvType(e, rxt.dataset.kind, rxt.dataset.rxt); return; }
        const chip = ev.target.closest('.lbw-kc');
        if (chip && chip.classList.contains('lbw-kc-conv') && !chip.classList.contains('lbw-editing')) {
            // a key the button has just made: a tap shows its endings instead of the text field
            const kind = chip.closest('.lbw-keys').dataset.kind;
            const k = e[kind][Number(chip.dataset.i)];
            const prev = convOpen;
            convOpen = prev?.kind === kind && prev.key === k ? null : { kind, key: k };
            if (prev && prev.kind !== kind) rerenderKeys(e, prev.kind);
            rerenderKeys(e, kind);
            return;
        }
        if (chip && !chip.classList.contains('lbw-editing') && !chip.classList.contains('lbw-kc-static')) { startChipEdit(chip); return; }
        const box = ev.target.closest('.lbw-keys');
        if (box && ev.target === box) { box.querySelector('.lbw-key-add')?.focus(); return; }
        const go = ev.target.closest('[data-go]');
        if (go) { onSelect(Number(go.dataset.go)); return; }
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'raw') { p.raw = !p.raw; savePrefs(); render(); }
        else if (act === 'rx-all') convertAll(e, ev.target.closest('[data-kind]').dataset.kind);
        else if (act === 'rx-undo') undoConv(e, ev.target.closest('[data-kind]').dataset.kind);
        else if (act === 'rx-text') {
            // leave the picker and edit this key as plain text, like any other chip
            const kind = ev.target.closest('[data-kind]').dataset.kind;
            const key = convOpen?.key;
            convOpen = null;
            // a changed text no longer matches the remembered regex, so "undo" leaves it alone by itself
            rerenderKeys(e, kind);
            const i = e[kind].indexOf(key);
            const c = i >= 0 && el.querySelector(`.lbw-keys[data-kind="${kind}"] .lbw-kc[data-i="${i}"]`);
            if (c) startChipEdit(c);
        }
        else if (act === 'builder') { builderOpen = !builderOpen; render(); }
        else if (act === 'back') { el.closest('.lbw-main')?.classList.remove('lbw-show-ed'); }
        else if (act === 'dup') duplicate(e);
        else if (act === 'up' || act === 'down') step(e, act === 'up' ? -1 : 1);
        else if (act === 'transfer') transfer(e);
        else if (act === 'del') remove(e);
        else if (act === 'native') openNative(e);
        else if (act === 'stmb') regenerateViaStmb(e, ev.target.closest('[data-act]'));
    });

    el.addEventListener('keydown', ev => {
        const add = ev.target.closest('.lbw-key-add');
        if (!add) return;
        if (ev.key === 'Enter') { ev.preventDefault(); commitAdd(add, true); }
    });
    // A key typed but not confirmed with Enter is kept when the field loses focus (a tap elsewhere on a phone).
    el.addEventListener('focusout', ev => {
        const add = ev.target.closest?.('.lbw-key-add');
        if (add && add.value.trim()) commitAdd(add, false);
    });

    function commitAdd(add, refocus) {
        const box = add.closest('.lbw-keys');
        const e = box && getEntry(Number(box.dataset.uid));
        const text = add.value;
        add.value = '';
        if (!e) return;
        const kind = box.dataset.kind;
        const next = splitKeywordsAndRegexes(text).filter(k => !(e[kind] || []).includes(k));
        if (!next.length) return;
        const arr = [...(e[kind] || []), ...next];
        if (e.uid === uid && box.isConnected) {
            setKeys(e, kind, arr);
            if (refocus) el.querySelector(`.lbw-keys[data-kind="${kind}"] .lbw-key-add`)?.focus();
        } else {
            // the form already shows another entry: store the key where it was typed
            setField(e, kind, arr);
            if (kind === 'keysecondary' && !e.selective) setField(e, 'selective', true);
            onChanged(e.uid);
        }
    }

    el.addEventListener('input', ev => {
        const e = getEntry(uid);
        const f = ev.target.dataset?.f;
        if (!e || !f) return;
        if (f === 'comment') {
            const wasSep = isSeparator(e);
            setField(e, 'comment', ev.target.value);
            // Becoming a folder header changes the list, not the form: the title field must keep the focus.
            if (wasSep !== isSeparator(e)) { onStructure(e.uid, { keepEditor: true }); patchPlace(); } else onChanged(e.uid);
        } else if (f === 'content') {
            setField(e, 'content', ev.target.value);
            countTokens(e.content, el.querySelector('.lbw-tok'));
            onChanged(e.uid);
            scheduleLinksSlow();
            refreshIssuesSlow();
        } else if (f === 'outletName') {
            setField(e, 'outletName', ev.target.value);
            refreshIssues();
        }
    });
    const scheduleLinksSlow = debounce(() => scheduleLinks(), 600);
    const refreshIssuesSlow = debounce(() => refreshIssues(), 400);

    el.addEventListener('change', ev => {
        const e = getEntry(uid);
        const t = ev.target;
        const f = t.dataset?.f;
        if (!e || !f) return;
        switch (f) {
            case 'mode': setMode(e, t.value); onChanged(e.uid); scheduleLinks(); break;
            case 'position': {
                setPosition(e, t.value);
                const was7 = !!el.querySelector('.lbw-outlet');
                if (was7 !== (e.position === 7)) render();
                else el.querySelector('[data-f="depth"]').disabled = e.position !== 4;
                onChanged(e.uid);
                break;
            }
            case 'depth': case 'order': case 'probability': {
                // an emptied field is not a zero: put the stored value back
                if (!String(t.value).trim()) { t.value = String(val(e, f)); return; }
                let n = Number(t.value);
                if (!Number.isFinite(n)) n = 0;
                if (f === 'probability') n = Math.max(0, Math.min(100, n));
                if (f === 'depth') n = Math.max(0, n);
                t.value = String(n);
                setField(e, f, n);
                onChanged(e.uid);
                break;
            }
            case 'enabled': setDisabled(e, !t.checked); onChanged(e.uid); scheduleLinks(); break;
            case 'preventRecursion': case 'excludeRecursion':
                setField(e, f, t.checked); scheduleLinks(); break;
            case 'delayUntilRecursion':
                setField(e, f, t.checked ? (e.delayUntilRecursion || true) : false); break;
            case 'selectiveLogic': setField(e, f, Number(t.value)); break;
            case 'folder':
                moveToFolder([e.uid], t.value === 'none' ? null : Number(t.value));
                onReordered(e.uid);
                return;
        }
        refreshIssues();
        onChanged(e.uid);
    });

    // ---------- actions ----------
    function folderSelectHTML(e) {
        if (isSeparator(e)) return '';
        const { folders } = folderLayout(entries());
        if (!folders.some(f => f.sep)) return '';
        const cur = folders.find(f => f.items.some(x => x.uid === e.uid));
        const opts = folders.map(f => {
            const v = f.sep ? esc(f.sep.uid) : 'none';
            const isCur = cur === f;
            return `<option value="${v}"${isCur ? ' selected' : ''}>${esc(f.sep ? folderName(f.sep) : tr('Без папки'))}</option>`;
        }).join('');
        return `<label class="lbw-folder" title="${tr('Перенести запись в конец другой папки')}">${tr('Папка')}<lbw-select class="lbw-in" data-f="folder">${opts}</lbw-select></label>`;
    }

    function step(e, dir) {
        if (!canReorder()) { toastr.info(tr('Сдвигать можно в сортировке «Свой порядок»')); return; }
        if (!moveStep([e.uid], dir)) { toastr.info(dir < 0 ? tr('Выше некуда') : tr('Ниже некуда')); return; }
        onReordered(e.uid);
    }

    async function transfer(e) {
        const pick = await askTarget(1);
        if (!pick) return;
        const next = pick.move ? neighbourOf(e.uid) : e.uid;
        if (await transferEntries([e.uid], pick.target, { move: pick.move })) onStructure(next);
    }

    function duplicate(e) {
        const follow = orderFollowsPosition();
        const copy = duplicateWorldInfoEntry(store.data, e.uid);
        if (!copy) return;
        copy.comment = (e.comment || '') + tr(' (копия)');
        insertAfter(copy, e, { renumber: follow });
        markDirty(copy.uid);
        onStructure(copy.uid);
    }

    async function remove(e) {
        const next = neighbourOf(e.uid);
        const ok = await deleteWorldInfoEntry(store.data, e.uid);
        if (!ok) return;
        deleteWIOriginalDataValue(store.data, e.uid);
        markDirty(e.uid);
        onStructure(next);
    }

    function neighbourOf(id) {
        const rows = [...el.getRootNode().querySelectorAll('.lbw-row:not(.lbw-fx), .lbw-fold:not(.lbw-fx)')];
        const i = rows.findIndex(r => Number(r.dataset.uid ?? r.dataset.fold) === id);
        const n = rows[i + 1] || rows[i - 1];
        return n ? Number(n.dataset.uid ?? n.dataset.fold) : null;
    }

    async function regenerateViaStmb(e, btn) {
        const kind = stmbKind(e);
        if (!kind || !stmbReady()) return;
        // MemoryBooks reads the saved lorebook: write pending edits first
        await flush();
        if (store.dirty.size) { toastr.warning(tr('Сначала дождись сохранения лорбука.')); return; }
        // Its handler wants its own button in the page (ours lives in a shadow root): a hidden stand-in carries the click.
        const proxy = document.createElement('button');
        proxy.type = 'button';
        proxy.className = STMB_BTN.slice(1);
        proxy.style.display = 'none';
        proxy.dataset.lorebookName = store.name;
        proxy.dataset.entryUid = String(e.uid);
        proxy.dataset.entryKind = kind;
        proxy.innerHTML = '<span></span>';
        document.body.appendChild(proxy);
        // MemoryBooks disables its button while it works: mirror that on ours, drop the stand-in afterwards
        let wasBusy = false;
        const watch = new MutationObserver(() => {
            if (proxy.disabled) wasBusy = true;
            if (btn.isConnected) btn.disabled = proxy.disabled;
            if (wasBusy && !proxy.disabled) { watch.disconnect(); proxy.remove(); }
        });
        watch.observe(proxy, { attributes: true, attributeFilter: ['disabled'] });
        setTimeout(() => { if (!wasBusy) { watch.disconnect(); proxy.remove(); } }, 3000);
        btn.blur();
        proxy.click();
    }

    async function openNative(e) {
        // The native form needs every template field present. If the user changes nothing,
        // put the entry back exactly as it was, so the file does not gain empty fields.
        const untouched = structuredClone(e);
        fillMissing(e);
        // ST's form normalises on render (an empty character filter is dropped) and may save through its own
        // path meanwhile; compare meanings, not bytes, to tell a real edit from that noise.
        const norm = x => {
            const c = structuredClone(x);
            fillMissing(c);
            const cf = c.characterFilter;
            if (cf && !cf.isExclude && !(cf.names || []).length && !(cf.tags || []).length) delete c.characterFilter;
            return JSON.stringify(c);
        };
        const before = norm(untouched);
        const ctx = SillyTavern.getContext();
        const block = await getWorldEntry(store.name, store.data, e);
        if (!block) return;
        block.find('.duplicate_entry_button, .delete_entry_button, .move_entry_button, .drag-handle').remove();
        const wrap = $('<div class="lbw-native"></div>').append(block);
        const popup = new ctx.Popup(wrap, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: tr('Готово') });
        const shown = popup.show();
        setTimeout(() => {
            const content = block.find('.inline-drawer-content').first();
            if (!content.is(':visible')) block.find('.inline-drawer-toggle').first().trigger('click');
        }, 30);
        await shown;
        if (store.data?.entries?.[e.uid] === e && norm(e) === before) {
            // Nothing meaningful changed: put the entry back byte for byte. Saving it undoes ST's render-time write.
            store.data.entries[e.uid] = untouched;
        }
        markDirty(e.uid);
        onStructure(e.uid);
    }

    return {
        render,
        patchPlace,
        get uid() { return uid; },
        focusTitle: () => el.querySelector('.lbw-title')?.focus(),
    };
}
