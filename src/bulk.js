import { deleteWIOriginalDataValue } from '../../../../world-info.js';
import { store, entries, getEntry, setField, setMode, setDisabled, setPosition, markDirty } from './store.js';
import { folderLayout } from './sort.js';
import { moveToFolder, moveStep } from './order.js';
import { askTarget, transferEntries } from './transfer.js';
import { esc, plural, folderName, POSITIONS } from './util.js';
import { tr } from './i18n.js';

const KEEP = '';

/**
 * Right-pane panel for the checked entries.
 * @param {HTMLElement} el
 * @param {{ getChecked: () => number[], onDone: (label:string, n:number, opts?:{cleared?:boolean}) => void, onClose: () => void }} hooks
 */
export function createBulk(el, { getChecked, onDone, onClose, onMoved = () => onDone('', 0), canReorder = () => true }) {
    function render() {
        const ids = getChecked().filter(u => getEntry(u));
        const list = ids.map(getEntry);
        const n = list.length;
        const { folders } = folderLayout(entries());
        const hasFolders = folders.some(f => f.sep);
        const folderOpts = folders.filter(f => f.sep || f.items.length || hasFolders)
            .map(f => `<option value="${f.sep ? f.sep.uid : 'none'}">${esc(f.sep ? folderName(f.sep) : tr('Без папки (в самом начале)'))}</option>`).join('');
        const tri = (f, l) => `<label>${l}<lbw-select class="lbw-in" data-tri="${f}"><option value="${KEEP}">${tr('не менять')}</option><option value="1">${tr('включить')}</option><option value="0">${tr('выключить')}</option></lbw-select></label>`;
        el.innerHTML = `
        <div class="lbw-ed lbw-bulk-ed">
            <div class="lbw-ed-top">
                <button type="button" class="lbw-btn" data-act="close">${tr('← К записи')}</button>
                <span class="lbw-sp"></span>
                <button type="button" class="lbw-btn" data-act="clear">${tr('Снять выделение')}</button>
            </div>
            <div class="lbw-bulk-title">${tr('Выбрано {0} {1}', n, plural(n, 'запись', 'записи', 'записей'))}</div>
            <div class="lbw-bulk-names">${list.slice(0, 40).map(e => `<span>${esc(e.comment || 'UID ' + e.uid)}</span>`).join('')}${n > 40 ? `<span>${tr('и ещё {0}', n - 40)}</span>` : ''}</div>
            <p class="lbw-muted lbw-small">${tr('Каждый блок применяется своей кнопкой. Остальные настройки записей не меняются.')}</p>

            ${hasFolders ? `<section class="lbw-sec lbw-bulk-sec">
                <div class="lbw-sec-h">${tr('Папка')}</div>
                <div class="lbw-bulk-line"><lbw-select class="lbw-in" data-f="folder">${folderOpts}</lbw-select><button type="button" class="lbw-btn" data-apply="folder">${tr('Перенести в конец папки')}</button></div>
            </section>` : ''}

            <section class="lbw-sec lbw-bulk-sec">
                <div class="lbw-sec-h">${tr('Место')}</div>
                <div class="lbw-bulk-line">
                    <button type="button" class="lbw-btn lbw-step" data-apply="up" title="${tr('Сдвинуть выбранные на одну позицию выше (собирает их подряд)')}">${tr('↑ Выше')}</button>
                    <button type="button" class="lbw-btn lbw-step" data-apply="down" title="${tr('Сдвинуть выбранные на одну позицию ниже (собирает их подряд)')}">${tr('↓ Ниже')}</button>
                    <button type="button" class="lbw-btn" data-apply="transfer">${tr('В другой лорбук…')}</button>
                </div>
            </section>

            <section class="lbw-sec lbw-bulk-sec">
                <div class="lbw-sec-h">${tr('Режим и позиция')}</div>
                <div class="lbw-bulk-line">
                    <lbw-select class="lbw-in" data-f="mode"><option value="constant">${tr('🔵 Константа')}</option><option value="normal" selected>${tr('🟢 По ключам')}</option><option value="vectorized">${tr('🔗 Векторы')}</option></lbw-select>
                    <button type="button" class="lbw-btn" data-apply="mode">${tr('Задать режим')}</button>
                </div>
                <div class="lbw-bulk-line">
                    <lbw-select class="lbw-in" data-f="position">${POSITIONS.map(o => `<option value="${o.v}">${esc(o.l)}</option>`).join('')}</lbw-select>
                    <input class="lbw-in lbw-bulk-num" type="number" min="0" data-f="depth" placeholder="${tr('глубина')}" title="${tr('Глубина для позиций @D. Пусто = не менять')}" disabled>
                    <button type="button" class="lbw-btn" data-apply="position">${tr('Задать позицию')}</button>
                </div>
                <div class="lbw-bulk-line">
                    <label class="lbw-inline">${tr('Шанс, %')}<input class="lbw-in lbw-bulk-num" type="number" min="0" max="100" data-f="probability" value="100"></label>
                    <button type="button" class="lbw-btn" data-apply="probability">${tr('Задать шанс')}</button>
                </div>
            </section>

            <section class="lbw-sec lbw-bulk-sec">
                <div class="lbw-sec-h">${tr('Рекурсия')}</div>
                <div class="lbw-grid lbw-bulk-tri">
                    ${tri('preventRecursion', tr('Не запускать рекурсию'))}
                    ${tri('excludeRecursion', tr('Не срабатывать от рекурсии'))}
                    ${tri('delayUntilRecursion', tr('Только через рекурсию'))}
                </div>
                <div class="lbw-bulk-line"><button type="button" class="lbw-btn" data-apply="recursion">${tr('Применить рекурсию')}</button></div>
            </section>

            <section class="lbw-sec lbw-bulk-sec">
                <div class="lbw-sec-h">${tr('Включение')}</div>
                <div class="lbw-bulk-line">
                    <button type="button" class="lbw-btn" data-apply="enable">${tr('Включить все')}</button>
                    <button type="button" class="lbw-btn" data-apply="disable">${tr('Выключить все')}</button>
                    <span class="lbw-sp"></span>
                    <button type="button" class="lbw-btn lbw-danger" data-apply="delete">${tr('Удалить выбранные…')}</button>
                </div>
            </section>
        </div>`;
    }

    el.addEventListener('change', ev => {
        if (ev.target.dataset.f === 'position') {
            const depth = el.querySelector('[data-f="depth"]');
            depth.disabled = !String(ev.target.value).startsWith('4');
        }
    });

    el.addEventListener('click', async ev => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (act === 'close') { onClose(); return; }
        if (act === 'clear') { onDone('', 0, { cleared: true }); return; }
        const what = ev.target.closest('[data-apply]')?.dataset.apply;
        if (!what) return;
        const ids = getChecked().filter(u => getEntry(u));
        if (!ids.length) return;
        const v = f => el.querySelector(`[data-f="${f}"]`)?.value;
        const each = fn => ids.forEach(u => fn(getEntry(u)));
        switch (what) {
            case 'folder': {
                const t = v('folder');
                moveToFolder(ids, t === 'none' ? null : Number(t));
                onMoved(tr('Перенесено'), ids.length);
                break;
            }
            case 'mode':
                each(e => setMode(e, v('mode')));
                onDone(tr('Режим задан'), ids.length);
                break;
            case 'position': {
                const pos = v('position');
                const d = v('depth');
                each(e => {
                    setPosition(e, pos);
                    if (pos.startsWith('4') && d !== '' && Number.isFinite(Number(d))) setField(e, 'depth', Math.max(0, Number(d)));
                });
                onDone(tr('Позиция задана'), ids.length);
                break;
            }
            case 'probability': {
                const n = Math.max(0, Math.min(100, Number(v('probability')) || 0));
                each(e => setField(e, 'probability', n));
                onDone(tr('Шанс {0}%', n), ids.length);
                break;
            }
            case 'recursion': {
                const changes = [...el.querySelectorAll('[data-tri]')].filter(s => s.value !== KEEP);
                if (!changes.length) { toastr.info(tr('Выбери, что включить или выключить')); return; }
                each(e => {
                    for (const s of changes) {
                        const on = s.value === '1';
                        const f = s.dataset.tri;
                        setField(e, f, f === 'delayUntilRecursion' ? (on ? (e.delayUntilRecursion || true) : false) : on);
                    }
                });
                onDone(tr('Рекурсия обновлена'), ids.length);
                break;
            }
            case 'up': case 'down': {
                if (!canReorder()) { toastr.info(tr('Сдвигать можно в сортировке «Свой порядок»')); return; }
                if (!moveStep(ids, what === 'up' ? -1 : 1)) { toastr.info(what === 'up' ? tr('Выше некуда') : tr('Ниже некуда')); return; }
                onMoved('', ids.length);
                break;
            }
            case 'transfer': {
                const pick = await askTarget(ids.length);
                if (!pick) return;
                if (await transferEntries(ids, pick.target, { move: pick.move })) onDone('', ids.length, { cleared: pick.move });
                break;
            }
            case 'enable': each(e => setDisabled(e, false)); onDone(tr('Включено'), ids.length); break;
            case 'disable': each(e => setDisabled(e, true)); onDone(tr('Выключено'), ids.length); break;
            case 'delete': {
                const ctx = SillyTavern.getContext();
                const ok = await ctx.Popup.show.confirm(tr('Удалить {0} {1}?', ids.length, plural(ids.length, 'запись', 'записи', 'записей')), tr('Это нельзя отменить.'));
                if (!ok) return;
                for (const u of ids) {
                    delete store.data.entries[u];
                    deleteWIOriginalDataValue(store.data, u);
                    markDirty(u);
                }
                onDone(tr('Удалено'), ids.length, { cleared: true });
                break;
            }
        }
    });

    return { render };
}
