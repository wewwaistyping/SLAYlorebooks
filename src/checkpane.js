import { world_names } from '../../../../world-info.js';
import { getRequestHeaders } from '../../../../../script.js';
import { store, entries } from './store.js';
import { checkBook, bookIssues, worst } from './check.js';
import { sortEntries } from './sort.js';
import { esc, plural, prefs, savePrefs } from './util.js';
import { tr } from './i18n.js';

function counts(map) {
    let err = 0, warn = 0, errEntries = 0;
    for (const issues of map.values()) {
        const e = issues.filter(i => i.sev === 'error').length;
        err += e;
        warn += issues.length - e;
        if (e) errEntries++;
    }
    return { err, warn, errEntries };
}

function issueList(issues, showWarn) {
    return issues.filter(i => showWarn || i.sev === 'error').map(i =>
        `<li class="lbw-issue-${i.sev}"><span class="lbw-issue-ico">${i.sev === 'error' ? '✖' : '⚠'}</span><span>${esc(i.msg)}${i.key ? `<code class="lbw-issue-key">${esc(i.key.length > 140 ? i.key.slice(0, 140) + '…' : i.key)}</code>` : ''}</span></li>`).join('');
}

export function summaryText(map) {
    const { err, warn, errEntries } = counts(map);
    if (!err && !warn) return tr('Ошибок нет: все записи могут сработать.');
    const parts = [];
    if (err) parts.push(tr('{0} {1} в {2} {3}', err, plural(err, 'ошибка', 'ошибки', 'ошибок'), errEntries, plural(errEntries, 'записи', 'записях', 'записях')));
    if (warn) parts.push(`${warn} ${plural(warn, 'предупреждение', 'предупреждения', 'предупреждений')}`);
    return parts.join(' · ');
}

/**
 * "Проверка" tab: problems of the open book, plus a scan over every lorebook.
 * @param {HTMLElement} el
 * @param {{ onOpen: (world:string, uid:number) => void }} hooks
 */
export function createCheckPane(el, { onOpen }) {
    const p = prefs();
    el.innerHTML = `
        <div class="lbw-ck-bar">
            <span class="lbw-ck-sum"></span><span class="lbw-sp"></span>
            <label class="lbw-check lbw-small"><input type="checkbox" class="lbw-ck-warn"${p.checkWarn === false ? '' : ' checked'}>${tr('Показывать предупреждения')}</label>
            <button type="button" class="lbw-btn" data-act="all">${tr('Проверить все лорбуки')}</button>
        </div>
        <p class="lbw-muted lbw-small lbw-ck-legend">${tr('✖ ошибка: запись или ключ не сработает. ⚠ предупреждение: сработает, но, возможно, не так, как задумано. Проверка ничего не меняет в лорбуке.')}</p>
        <div class="lbw-ck-list"></div>
        <div class="lbw-ck-all" hidden></div>`;
    const $sum = el.querySelector('.lbw-ck-sum');
    const $list = el.querySelector('.lbw-ck-list');
    const $all = el.querySelector('.lbw-ck-all');
    const $warn = el.querySelector('.lbw-ck-warn');
    let allJob = 0;

    function render() {
        const map = bookIssues.map;
        const showWarn = $warn.checked;
        if (!store.data) { $sum.textContent = ''; $list.innerHTML = `<div class="lbw-empty">${tr('Выбери лорбук.')}</div>`; return; }
        $sum.innerHTML = `<b>${esc(store.name)}</b> · ${esc(summaryText(map))}`;
        const ordered = sortEntries(entries(), 'custom').filter(e => map.has(e.uid));
        const rank = e => worst(map.get(e.uid)) === 'error' ? 0 : 1;
        ordered.sort((a, b) => rank(a) - rank(b));
        const blocks = ordered
            .filter(e => showWarn || worst(map.get(e.uid)) === 'error')
            .map(e => `<div class="lbw-ck-item"><button type="button" class="lbw-ck-title lbw-${worst(map.get(e.uid))}" data-world="${esc(store.name)}" data-uid="${e.uid}">${esc(e.comment || 'UID ' + e.uid)}</button><ul class="lbw-issues">${issueList(map.get(e.uid), showWarn)}</ul></div>`)
            .join('');
        $list.innerHTML = blocks || `<div class="lbw-empty">${map.size ? tr('Ошибок нет, только предупреждения.') : tr('Всё в порядке.')}</div>`;
    }

    async function checkAll() {
        const job = ++allJob;
        const names = [...(world_names || [])];
        $all.hidden = false;
        $all.innerHTML = `<div class="lbw-muted">${tr('Проверяю…')}</div>`;
        const results = [];
        for (let i = 0; i < names.length; i++) {
            if (job !== allJob) return;
            const name = names[i];
            let data = null;
            if (name === store.name) data = store.data;
            else {
                try {
                    const res = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-cache' });
                    if (res.ok) data = await res.json();
                } catch { /* skip unreadable book */ }
            }
            if (data?.entries) {
                const list = Object.values(data.entries).filter(e => e && typeof e === 'object');
                const map = checkBook(list);
                const c = counts(map);
                if (c.err) results.push({ name, map, list, c });
            }
            if (i % 8 === 0) $all.innerHTML = `<div class="lbw-muted">${tr('Проверено {0} из {1}…', i + 1, names.length)}</div>`;
        }
        if (job !== allJob) return;
        const totalErr = results.reduce((a, r) => a + r.c.err, 0);
        const head = results.length
            ? `<div class="lbw-ck-allhead">${tr('Все лорбуки ({0}): ошибки в {1} {2}, всего {3}.', names.length, results.length, plural(results.length, 'лорбуке', 'лорбуках', 'лорбуках'), totalErr)}</div>`
            : `<div class="lbw-ck-allhead">${tr('Все лорбуки ({0}): ошибок не нашлось.', names.length)}</div>`;
        $all.innerHTML = head + results.map(r => {
            const errEntries = r.list.filter(e => worst(r.map.get(e.uid)) === 'error');
            return `<details class="lbw-ck-book"${results.length <= 4 ? ' open' : ''}><summary><b>${esc(r.name)}</b> <span class="lbw-muted">${r.c.err} ${plural(r.c.err, 'ошибка', 'ошибки', 'ошибок')}</span></summary>`
                + errEntries.map(e => `<div class="lbw-ck-item"><button type="button" class="lbw-ck-title lbw-error" data-world="${esc(r.name)}" data-uid="${e.uid}">${esc(e.comment || 'UID ' + e.uid)}</button><ul class="lbw-issues">${issueList(r.map.get(e.uid), false)}</ul></div>`).join('')
                + '</details>';
        }).join('');
    }

    $warn.addEventListener('change', () => { p.checkWarn = $warn.checked; savePrefs(); render(); });
    el.addEventListener('click', ev => {
        if (ev.target.closest('[data-act="all"]')) { checkAll(); return; }
        const t = ev.target.closest('.lbw-ck-title');
        if (t) onOpen(t.dataset.world, Number(t.dataset.uid));
    });

    return { render };
}
