// Move or copy entries into another lorebook. Same result as ST's own "Move/Copy" button in the native
// entry header, but works for several entries at once and keeps unsaved edits.
import { world_names, worldInfoCache, getFreeWorldEntryUid, deleteWIOriginalDataValue } from '../../../../world-info.js';
import { eventSource, event_types, getRequestHeaders } from '../../../../../script.js';
import { store, getEntry, markDirty, flush } from './store.js';
import { sortEntries, di } from './sort.js';
import { esc, plural } from './util.js';
import { tr } from './i18n.js';

const RESULT_MOVE = 1001;
const RESULT_COPY = 1002;

/** Asks for the target book and the action. Resolves to { target, move } or null. */
export async function askTarget(count) {
    const ctx = SillyTavern.getContext();
    const names = (world_names || []).filter(n => n !== store.name);
    if (!names.length) { toastr.info(tr('Других лорбуков нет')); return null; }
    const wrap = document.createElement('div');
    wrap.className = 'lbw-transfer';
    wrap.innerHTML = `
        <h3 style="margin:0 0 8px">${tr('{0} в другой лорбук', count === 1 ? tr('Запись') : `${count} ${plural(count, 'запись', 'записи', 'записей')}`)}</h3>
        <input type="search" class="text_pole" placeholder="${tr('Найти лорбук')}" style="width:100%;margin:0 0 6px">
        <select class="text_pole" size="12" style="width:100%">${names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>
        <small style="opacity:.75;display:block;margin-top:6px">${tr('Запись встанет в конец выбранного лорбука. «Перенести» убирает её отсюда, «Копировать» оставляет и тут, и там.')}</small>`;
    const search = wrap.querySelector('input');
    const list = wrap.querySelector('select');
    search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        for (const o of list.options) o.hidden = !!q && !o.value.toLowerCase().includes(q);
        const firstShown = [...list.options].find(o => !o.hidden);
        if (list.selectedOptions[0]?.hidden !== false && firstShown) list.value = firstShown.value;
    });
    const popup = new ctx.Popup(wrap, ctx.POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: tr('Отмена'),
        customButtons: [
            { text: tr('Перенести'), result: RESULT_MOVE },
            { text: tr('Копировать'), result: RESULT_COPY },
        ],
    });
    if (popup.okButton) popup.okButton.style.display = 'none';
    setTimeout(() => search.focus(), 50);
    const res = await popup.show();
    if (res !== RESULT_MOVE && res !== RESULT_COPY) return null;
    const target = list.value;
    if (!target) { toastr.warning(tr('Не выбран лорбук')); return null; }
    return { target, move: res === RESULT_MOVE };
}

/**
 * Copies the entries (in their list order) to the end of `target`; with move=true removes them here.
 * Every field is copied as is, including other extensions' data, like ST's native move.
 */
export async function transferEntries(uids, target, { move }) {
    if (!store.data || !target || target === store.name) return false;
    const data = store.data;
    // The book may change while we wait (a rename, an external reload): then the uids would point at other entries.
    const switched = () => { if (store.data !== data) { toastr.warning(tr('Лорбук сменился, перенос отменён')); return true; } return false; };
    await flush();
    if (switched()) return false;
    let tdata;
    try {
        const res = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: target }), cache: 'no-cache' });
        if (res.ok) tdata = await res.json();
    } catch { /* handled below */ }
    if (!tdata?.entries || typeof tdata.entries !== 'object') { toastr.error(tr('Не получилось открыть «{0}»', target)); return false; }
    if (switched()) return false;

    const ids = new Set(uids.map(Number));
    const picked = sortEntries(Object.values(data.entries), 'custom').filter(e => ids.has(e.uid));
    if (!picked.length) return false;

    // Continue the target's numbering when its order already counts down by 1 along the list.
    const tSeq = sortEntries(Object.values(tdata.entries), 'custom');
    const consecutive = tSeq.length >= 2 && tSeq.every((e, i) => i === 0 || Number(tSeq[i - 1].order) - Number(e.order) === 1);
    let nextDisplay = tSeq.reduce((m, e) => Math.max(m, di(e)), -1) + 1;
    let nextOrder = consecutive ? Number(tSeq[tSeq.length - 1].order) - 1 : null;

    for (const src of picked) {
        const copy = structuredClone(src);
        copy.uid = getFreeWorldEntryUid(tdata);
        if (!Number.isInteger(copy.uid)) { toastr.error(tr('В целевом лорбуке не нашлось свободного UID')); return false; }
        copy.displayIndex = nextDisplay++;
        if (nextOrder !== null) copy.order = Math.max(0, nextOrder--);
        tdata.entries[copy.uid] = copy;
    }

    try {
        const res = await fetch('/api/worldinfo/edit', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: target, data: tdata }) });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    } catch (e) {
        console.error('[SLAYlorebooks] transfer save failed', e);
        toastr.error(tr('Не удалось сохранить «{0}»', target));
        return false;
    }
    worldInfoCache.set(target, tdata);
    await eventSource.emit(event_types.WORLDINFO_UPDATED, target, tdata);

    if (move) {
        if (switched()) { toastr.warning(tr('Записи скопированы, но не удалены отсюда: лорбук сменился')); return true; }
        for (const e of picked) {
            delete data.entries[e.uid];
            deleteWIOriginalDataValue(data, e.uid);
            markDirty(e.uid);
        }
        await flush();
    }
    const n = picked.length;
    toastr.success(tr(move ? tr('Перенесено в «{0}»: {1} {2}') : tr('Скопировано в «{0}»: {1} {2}'), target, n, plural(n, 'запись', 'записи', 'записей')));
    return true;
}

export const entryExists = uid => !!getEntry(uid);
