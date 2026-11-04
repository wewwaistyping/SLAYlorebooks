import { buildKey, BUILDER_TYPES, isLatin, keyChipInner, keyMatches } from './keys.js';
import { entries } from './store.js';
import { esc, plural } from './util.js';
import { tr, isRu } from './i18n.js';

function guessType(word) {
    const w = word.trim().toLowerCase();
    if (isLatin(w)) return 'exact';
    const last = w.split(/\s+/).pop() || '';
    if (/(ый|ий|ой)$/.test(last)) return 'adj';
    if (/я$/.test(last)) return 'ya';
    if (/а$/.test(last)) return 'a';
    return 'm';
}

/**
 * Key builder: word + declension type → regex in the house style.
 * @param {HTMLElement} el
 * @param {{ targets: {id:string, l:string}[], onAdd: (regex:string, target:string) => void, excludeUid?: () => number|null }} opts
 */
export function mountBuilder(el, { targets, onAdd, excludeUid = () => null }) {
    el.classList.add('lbw-builder');
    el.innerHTML = `
        <div class="lbw-b-line">
            <input class="lbw-in lbw-b-word" placeholder="${tr('Слово: Лиса, Старый, Fox')}" aria-label="${tr('Слово для ключа')}">
            <lbw-select class="lbw-in lbw-b-type" aria-label="${tr('Склонение')}"></lbw-select>
        </div>
        <div class="lbw-b-prev"></div>
        <div class="lbw-b-msg"></div>
        <div class="lbw-b-actions">
            ${targets.map(t => `<button type="button" class="lbw-btn" data-t="${t.id}">${esc(t.l)}</button>`).join('')}
            <button type="button" class="lbw-btn" data-t="copy">${tr('Скопировать')}</button>
        </div>`;
    const $word = el.querySelector('.lbw-b-word');
    const $type = el.querySelector('.lbw-b-type');
    const $prev = el.querySelector('.lbw-b-prev');
    const $msg = el.querySelector('.lbw-b-msg');
    let script = 'ru';
    let manualType = false;

    function fillTypes() {
        const word = $word.value.trim();
        const next = (word ? isLatin(word) : !isRu) ? 'en' : 'ru';
        if (next !== script || !$type.options.length) {
            script = next;
            $type.setOptionsHTML(BUILDER_TYPES[script].map(t => `<option value="${t.v}">${esc(t.l)}</option>`).join(''));
            manualType = false;
        }
        if (!manualType) {
            const g = guessType($word.value);
            if ([...$type.options].some(o => o.value === g)) $type.value = g;
        }
    }

    function current() { return buildKey($word.value, $type.value); }

    function update() {
        fillTypes();
        const rx = current();
        if (!rx) { $prev.innerHTML = ''; $msg.textContent = ''; return; }
        $prev.innerHTML = `<span class="lbw-kc lbw-kc-static">${keyChipInner(rx, false)}</span><code class="lbw-b-raw">${esc(rx)}</code>`;
        const ex = excludeUid();
        const all = entries().filter(e => e.uid !== ex);
        const owners = all.filter(e => (e.key || []).includes(rx) || (e.keysecondary || []).includes(rx));
        const probe = { caseSensitive: null, matchWholeWords: null };
        const inTexts = all.filter(e => e.content && keyMatches('\x01' + e.content, rx, probe)).length;
        const parts = [];
        if (owners.length) parts.push(tr('Такой ключ уже есть: {0}.', owners.map(e => e.comment || ('UID ' + e.uid)).slice(0, 3).join(', ')));
        parts.push(inTexts ? tr('Встречается в текстах {0} {1}.', inTexts, plural(inTexts, 'записи', 'записей', 'записей')) : tr('В текстах других записей не встречается.'));
        $msg.textContent = parts.join(' ');
    }

    $word.addEventListener('input', update);
    $type.addEventListener('change', () => { manualType = true; update(); });
    el.querySelector('.lbw-b-actions').addEventListener('click', async ev => {
        const b = ev.target.closest('button[data-t]');
        if (!b) return;
        const rx = current();
        if (!rx) { $word.focus(); return; }
        if (b.dataset.t === 'copy') {
            try { await navigator.clipboard.writeText(rx); toastr.success(tr('Ключ скопирован')); }
            catch { toastr.info(rx, tr('Скопируй вручную')); }
            return;
        }
        onAdd(rx, b.dataset.t);
        $word.value = '';
        update();
        $word.focus();
    });
    update();
    return { focus: () => $word.focus(), refresh: update };
}
