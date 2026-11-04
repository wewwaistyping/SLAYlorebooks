import {
    getWorldEntry,
    splitKeywordsAndRegexes,
    duplicateWorldInfoEntry,
    deleteWorldInfoEntry,
    deleteWIOriginalDataValue,
    world_info_recursive,
} from '../../../../world-info.js';
import { store, entries, getEntry, val, setField, setMode, setDisabled, setPosition, markDirty, fillMissing } from './store.js';
import { esc, plural, isSeparator, folderName, POSITIONS, positionValue, prefs, savePrefs, debounce } from './util.js';
import { keyChipInner, entryMatches } from './keys.js';
import { mountBuilder } from './builder.js';
import { insertAfter, moveToFolder, orderFollowsPosition, moveStep } from './order.js';
import { askTarget, transferEntries } from './transfer.js';
import { keyIssueFor, issuesFor } from './check.js';
import { folderLayout } from './sort.js';
import { countNow } from './tokens.js';
import { tr } from './i18n.js';

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
export function createEditor(el, { onChanged, onSelect, onStructure, canReorder = () => true }) {
    const p = prefs();
    let uid = null;
    let builderOpen = false;
    let linksJob = 0;

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
            const cls = bad ? ` lbw-kc-${bad.sev}` : '';
            const tip = (bad ? `${bad.sev === 'error' ? '✖' : '⚠'} ${bad.msg}\n\n` : '') + `${k}\n\n${tr('Нажми, чтобы изменить')}`;
            return `<span class="lbw-kc${cls}" data-i="${i}" title="${esc(tip)}">${bad ? `<b class="lbw-kc-flag">${bad.sev === 'error' ? '✖' : '⚠'}</b>` : ''}${keyChipInner(k, p.raw)}<button type="button" class="lbw-kc-x" title="${tr('Удалить ключ')}" aria-label="${tr('Удалить ключ')}">×</button></span>`;
        }).join('');
        const ph = kind === 'key' ? (arr.length ? tr('+ ключ') : tr('слово или /regex/, Enter')) : (arr.length ? tr('+ ключ') : tr('вторичные ключи, Enter'));
        return `<div class="lbw-keys" data-kind="${kind}">${chips}<input class="lbw-key-add" placeholder="${ph}" aria-label="${tr('Добавить ключ')}"></div>`;
    }

    function render(nextUid = uid) {
        uid = nextUid;
        const e = uid == null ? null : getEntry(uid);
        if (!store.data) { el.innerHTML = `<div class="lbw-empty">${tr('Выбери лорбук в строке выше или создай новый.')}</div>`; return; }
        if (!e) { el.innerHTML = `<div class="lbw-empty">${tr('Выбери запись слева.')}</div>`; return; }
        const sep = isSeparator(e);
        const mode = e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'normal';
        const pos = positionValue(e);
        const isDepth = Number(e.position) === 4;
        const k2 = Array.isArray(e.keysecondary) ? e.keysecondary : [];
        const scrollTop = el.scrollTop;
        el.innerHTML = `
        <div class="lbw-ed">
            <div class="lbw-ed-top">
                <button type="button" class="lbw-btn lbw-back" data-act="back">${tr('← Список')}</button>
                <span class="lbw-ed-uid">UID ${e.uid}</span>
                <span class="lbw-sp"></span>
                ${folderSelectHTML(e)}
                <span class="lbw-step-group" role="group" aria-label="${tr('Сдвинуть')}">
                    <button type="button" class="lbw-btn lbw-step" data-act="up" title="${sep ? tr('Поднять папку целиком') : tr('Сдвинуть запись выше')}" aria-label="${tr('Выше')}">↑</button>
                    <button type="button" class="lbw-btn lbw-step" data-act="down" title="${sep ? tr('Опустить папку целиком') : tr('Сдвинуть запись ниже')}" aria-label="${tr('Ниже')}">↓</button>
                </span>
                <button type="button" class="lbw-btn" data-act="transfer" title="${tr('Перенести или скопировать запись в другой лорбук')}">${tr('В лорбук…')}</button>
                <button type="button" class="lbw-btn" data-act="dup" title="${tr('Создать копию записи рядом')}">${tr('Дублировать')}</button>
                <button type="button" class="lbw-btn lbw-danger" data-act="del" title="${tr('Удалить запись')}">${tr('Удалить')}</button>
            </div>
            <input class="lbw-in lbw-title" data-f="comment" value="${esc(e.comment || '')}" placeholder="${tr('Название записи')}" aria-label="${tr('Название записи')}">
            ${sep ? `<div class="lbw-hint">${tr('Это разделитель: название начинается с «===», поэтому в списке он работает как папка для записей ниже.')}</div>` : ''}
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
                    <button type="button" class="lbw-tgl${p.raw ? ' lbw-on' : ''}" data-act="raw" title="${tr('Показывать ключи как они записаны в файле')}">regex</button>
                    <button type="button" class="lbw-tgl${builderOpen ? ' lbw-on' : ''}" data-act="builder">${tr('Конструктор')}</button>
                </div>
                ${keysHTML(e, 'key')}
                <div class="lbw-builder-slot"${builderOpen ? '' : ' hidden'}></div>
            </section>
            <section class="lbw-sec">
                <div class="lbw-sec-h">${tr('Вторичные ключи')} <span class="lbw-cnt">${k2.length}</span><span class="lbw-sp"></span>
                    <lbw-select class="lbw-in lbw-logic" data-f="selectiveLogic" aria-label="${tr('Логика вторичных ключей')}"${k2.length ? '' : ' disabled'}>${LOGIC.map(o => `<option value="${o.v}"${Number(val(e, 'selectiveLogic')) === o.v ? ' selected' : ''}>${o.l}</option>`).join('')}</lbw-select>
                </div>
                ${keysHTML(e, 'keysecondary')}
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
        const chip = (x, live) => `<button type="button" class="lbw-lk${live ? ' lbw-live' : ' lbw-dead'}" data-go="${x.uid}" title="${live ? tr('подтянет рекурсией') : tr('упоминает, но не подтянет')}">${esc(x.comment || 'UID ' + x.uid)}</button>`;
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
        const tmp = document.createElement('div');
        tmp.innerHTML = keysHTML(e, kind);
        box.replaceWith(tmp.firstElementChild);
        const sec = el.querySelector(`.lbw-keys[data-kind="${kind}"]`)?.closest('.lbw-sec');
        const cnt = sec?.querySelector('.lbw-cnt');
        if (cnt) cnt.textContent = String((e[kind] || []).length);
        if (kind === 'keysecondary') {
            const lg = el.querySelector('.lbw-logic');
            if (lg) lg.disabled = !(e.keysecondary || []).length;
        }
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
        const chip = ev.target.closest('.lbw-kc');
        if (chip && !chip.classList.contains('lbw-editing') && !chip.classList.contains('lbw-kc-static')) { startChipEdit(chip); return; }
        const box = ev.target.closest('.lbw-keys');
        if (box && ev.target === box) { box.querySelector('.lbw-key-add')?.focus(); return; }
        const go = ev.target.closest('[data-go]');
        if (go) { onSelect(Number(go.dataset.go)); return; }
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'raw') { p.raw = !p.raw; savePrefs(); render(); }
        else if (act === 'builder') { builderOpen = !builderOpen; render(); }
        else if (act === 'back') { el.closest('.lbw-main')?.classList.remove('lbw-show-ed'); }
        else if (act === 'dup') duplicate(e);
        else if (act === 'up' || act === 'down') step(e, act === 'up' ? -1 : 1);
        else if (act === 'transfer') transfer(e);
        else if (act === 'del') remove(e);
        else if (act === 'native') openNative(e);
    });

    el.addEventListener('keydown', ev => {
        const add = ev.target.closest('.lbw-key-add');
        if (!add) return;
        if (ev.key === 'Enter') {
            ev.preventDefault();
            const e = getEntry(uid);
            const kind = add.closest('.lbw-keys').dataset.kind;
            const next = splitKeywordsAndRegexes(add.value).filter(k => !(e[kind] || []).includes(k));
            if (!next.length) { add.value = ''; return; }
            setKeys(e, kind, [...(e[kind] || []), ...next]);
            el.querySelector(`.lbw-keys[data-kind="${kind}"] .lbw-key-add`)?.focus();
        }
    });

    el.addEventListener('input', ev => {
        const e = getEntry(uid);
        const f = ev.target.dataset?.f;
        if (!e || !f) return;
        if (f === 'comment') {
            const wasSep = isSeparator(e);
            setField(e, 'comment', ev.target.value);
            if (wasSep !== isSeparator(e)) onStructure(e.uid); else onChanged(e.uid);
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
                onStructure(e.uid);
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
            const v = f.sep ? String(f.sep.uid) : 'none';
            const isCur = cur === f;
            return `<option value="${v}"${isCur ? ' selected' : ''}>${esc(f.sep ? folderName(f.sep) : tr('Без папки'))}</option>`;
        }).join('');
        return `<label class="lbw-folder" title="${tr('Перенести запись в конец другой папки')}">${tr('Папка')}<lbw-select class="lbw-in" data-f="folder">${opts}</lbw-select></label>`;
    }

    function step(e, dir) {
        if (!canReorder()) { toastr.info(tr('Сдвигать можно в сортировке «Свой порядок»')); return; }
        if (!moveStep([e.uid], dir)) { toastr.info(dir < 0 ? tr('Выше некуда') : tr('Ниже некуда')); return; }
        onStructure(e.uid);
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
        const rows = [...el.getRootNode().querySelectorAll('.lbw-row, .lbw-fold')];
        const i = rows.findIndex(r => Number(r.dataset.uid ?? r.dataset.fold) === id);
        const n = rows[i + 1] || rows[i - 1];
        return n ? Number(n.dataset.uid ?? n.dataset.fold) : null;
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
        get uid() { return uid; },
        focusTitle: () => el.querySelector('.lbw-title')?.focus(),
    };
}
