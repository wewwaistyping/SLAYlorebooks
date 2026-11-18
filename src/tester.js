import {
    getSortedEntries,
    checkWorldInfo,
    world_info_recursive,
    world_info_max_recursion_steps,
    world_info_depth,
    world_info_include_names,
    world_info_budget,
    world_info_budget_cap,
} from '../../../../world-info.js';
import { eventSource, event_types, getMaxPromptTokens } from '../../../../../script.js';
import { store, entries, flush } from './store.js';
import { entryMatches, keyRanges } from './keys.js';
import { mountBuilder } from './builder.js';
import { isForced, isSuppressed } from './check.js';
import { tokenInfo, tokenSum, requestTokens } from './tokens.js';
import { esc, tokLabel, fmtTokens, plural, prefs, savePrefs, debounce, isSeparator } from './util.js';
import { tr } from './i18n.js';

const SAMPLE_RU = 'Вставь сюда сообщение или нажми «Из чата», и я покажу, какие записи сработают и на каком слове.';
const SAMPLE = tr(SAMPLE_RU);

// ---------- conditions that keep a matched entry out (no RNG involved) ----------
function currentCharacter() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) return null; // group chats: ST checks every member, not simulated here
    const ch = ctx.characters?.[ctx.characterId];
    if (!ch) return null;
    const file = String(ch.avatar || '').replace(/\.[^/.]+$/, '');
    const tagIds = (ctx.tagMap?.[ch.avatar] || []).map(String);
    return { file, tagIds };
}

/** Same rule as ST's character filter. Returns a reason or null. */
function characterBlock(e, ch) {
    const cf = e.characterFilter;
    if (!cf || !ch) return null;
    const names = cf.names || [], tags = (cf.tags || []).map(String);
    if (!names.length && !tags.length) return null;
    // ST applies the name list and the tag list one after the other: to be included the character
    // must pass both; to be excluded, matching either is enough.
    const nameHit = names.includes(ch.file), tagHit = tags.some(t => ch.tagIds.includes(t));
    if (cf.isExclude) return nameHit || tagHit ? tr('фильтр персонажей: этот персонаж исключён') : null;
    const ok = (!names.length || nameHit) && (!tags.length || tagHit);
    return ok ? null : tr('фильтр персонажей: только для других персонажей');
}

function delayBlock(e, chatLen) {
    const d = Number(e.delay);
    if (d > 0 && chatLen < d) return tr('delay {0}: включится не раньше {0}-го сообщения, в чате сейчас {1}', d, chatLen);
    return null;
}

/**
 * Keyword simulation: constants, primary/secondary keys, recursion with preventRecursion /
 * excludeRecursion / delayUntilRecursion, per-entry scan depth (when the text came from the chat),
 * character filter and delay. Probability, groups and budget are reported, not rolled.
 * @param {{e:object, world:string}[]} items
 * @param {{ text: string, msgs: string[]|null, ch: object|null, chatLen: number }} src
 */
export function simulate(items, { text, msgs, ch, chatLen }) {
    const scanFor = e => {
        if (!msgs) return '\x01' + text;
        const depth = Number.isFinite(e.scanDepth) && e.scanDepth !== null ? e.scanDepth : world_info_depth;
        if (depth <= 0) return ''; // ST scans nothing for depth 0, not even recursion text
        return '\x01' + msgs.slice(-depth).join('\n\x01');
    };
    // Leading @@decorator lines are not text ST matches against.
    const body = e => String(e.content || '').replace(/^\s*(?:@@[^\n]*\n?)+/, '');
    const live = items.filter(it => !it.e.disable && !isSuppressed(it.e));
    const act = new Map();
    const blocked = new Map();
    const tryAdd = (it, how, key, extra = {}) => {
        const why = characterBlock(it.e, ch) || delayBlock(it.e, chatLen);
        if (why) { blocked.set(it, { how, key, why }); return false; }
        act.set(it, { how, key, ...extra });
        return true;
    };
    for (const it of live) {
        const e = it.e;
        if (e.delayUntilRecursion) continue;
        if (e.constant || isForced(e)) { tryAdd(it, 'const'); continue; }
        const text = scanFor(e);
        const k = text && entryMatches(e, text);
        if (k) tryAdd(it, 'key', k);
    }
    if (world_info_recursive) {
        let fresh = [...act.keys()];
        let recText = '';
        let steps = 0;
        const max = world_info_max_recursion_steps > 0 ? world_info_max_recursion_steps : 30;
        while (fresh.length && steps++ < max) {
            const add = fresh.filter(it => !it.e.preventRecursion && body(it.e)).map(it => body(it.e));
            if (!add.length) break;
            recText += '\n\x01' + add.join('\n\x01');
            const next = [];
            for (const it of live) {
                if (act.has(it) || blocked.has(it) || it.e.excludeRecursion) continue;
                // a constant with "only via recursion" joins on the first recursion step
                if (it.e.constant || isForced(it.e)) { if (tryAdd(it, 'const')) next.push(it); continue; }
                const base = scanFor(it.e);
                if (!base) continue;
                const k = entryMatches(it.e, base + recText);
                if (!k) continue;
                const via = [...act.keys()].filter(s => !s.e.preventRecursion && body(s.e) && entryMatches(it.e, '\x01' + body(s.e)));
                if (tryAdd(it, 'rec', k, { via })) next.push(it);
            }
            fresh = next;
        }
    }
    return { act, blocked };
}

/** The same context size ST passes to World Info when generating. */
function promptTokens() {
    try { const n = Number(getMaxPromptTokens()); if (n > 0) return n; } catch { /* fall back */ }
    return Number(SillyTavern.getContext().maxContext) || 8192;
}

function wiBudget() {
    const maxContext = promptTokens();
    let b = Math.round(world_info_budget * maxContext / 100) || 1;
    if (world_info_budget_cap > 0 && b > world_info_budget_cap) b = world_info_budget_cap;
    return b;
}

export function createTester(el, { onOpen, addKey }) {
    const p = prefs();
    el.innerHTML = `
        <div class="lbw-test-in">
            <div class="lbw-test-bar">
                <span class="lbw-sec-h">${tr('Текст')}</span><span class="lbw-sp"></span>
                <label class="lbw-muted lbw-inline">${tr('сообщений')} <input type="number" class="lbw-in lbw-test-n" min="1" max="50" value="${p.testN || world_info_depth || 2}" aria-label="${tr('Сколько последних сообщений взять')}"></label>
                <button type="button" class="lbw-btn" data-act="chat">${tr('Из чата')}</button>
            </div>
            <div class="lbw-test-bar">
                <lbw-select class="lbw-in lbw-scope" aria-label="${tr('Как проверять')}">
                    <option value="book">${tr('Этот лорбук')}</option>
                    <option value="active">${tr('Все активные лорбуки')}</option>
                    <option value="st">${tr('Как в ST: полная проверка')}</option>
                </lbw-select>
                <button type="button" class="lbw-btn" data-act="rerun" title="${tr('Прогнать ещё раз: шанс бросается заново')}">${tr('Ещё раз')}</button>
            </div>
            <div class="lbw-test-src lbw-muted lbw-small"></div>
            <textarea class="lbw-in lbw-test-text" aria-label="${tr('Текст для проверки')}"></textarea>
            <div class="lbw-sec-h">${tr('Где сработало')}</div>
            <div class="lbw-test-hl"></div>
            <div class="lbw-sec-h">${tr('Конструктор ключа')}</div>
            <div class="lbw-test-builder"></div>
        </div>
        <div class="lbw-test-out"></div>`;
    const $text = el.querySelector('.lbw-test-text');
    const $hl = el.querySelector('.lbw-test-hl');
    const $out = el.querySelector('.lbw-test-out');
    const $scope = el.querySelector('.lbw-scope');
    const $n = el.querySelector('.lbw-test-n');
    const $src = el.querySelector('.lbw-test-src');
    $text.value = !p.testText || p.testText === SAMPLE_RU ? SAMPLE : p.testText;
    $scope.value = p.testScope || 'book';

    /** When the text was taken from the chat, the separate messages (oldest first); null for typed text. */
    let chatMsgs = null;
    const showSource = () => {
        $src.textContent = chatMsgs
            ? tr('Текст из чата: {0} {1}, глубина сканирования учитывается для каждой записи.', chatMsgs.length, plural(chatMsgs.length, 'сообщение', 'сообщения', 'сообщений'))
            : tr('Свой текст: считается одним сообщением.');
    };
    showSource();

    mountBuilder(el.querySelector('.lbw-test-builder'), {
        targets: [{ id: 'key', l: tr('В ключи открытой записи') }],
        excludeUid: () => null,
        onAdd: rx => addKey(rx),
    });

    let lastItems = [];
    async function collect(scope) {
        const mine = entries().map(e => ({ e, world: store.name }));
        if (scope === 'book') return { items: mine, activeHasMine: true };
        let all = [];
        try { all = await getSortedEntries(); } catch (e) { console.error('[SLAYlorebooks] getSortedEntries failed', e); }
        const activeHasMine = all.some(x => x.world === store.name);
        const others = all.filter(x => x.world !== store.name).map(e => ({ e, world: e.world }));
        return { items: activeHasMine ? [...mine, ...others] : others, activeHasMine };
    }

    function highlight(text, matched) {
        const ranges = [];
        for (const it of matched) for (const [s, e] of keyRanges(it.e, text)) ranges.push([s, e, it.e.comment || 'UID ' + it.e.uid]);
        ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
        const merged = [];
        for (const r of ranges) {
            const last = merged[merged.length - 1];
            if (last && r[0] < last[1]) { last[1] = Math.max(last[1], r[1]); if (!last[2].includes(r[2])) last[2].push(r[2]); }
            else merged.push([r[0], r[1], [r[2]]]);
        }
        let h = '', pos = 0;
        for (const [s, e, names] of merged) { h += esc(text.slice(pos, s)) + `<mark title="${esc(names.join(', '))}">${esc(text.slice(s, e))}</mark>`; pos = e; }
        h += esc(text.slice(pos));
        $hl.innerHTML = h.trim() ? h : `<span class="lbw-muted">${tr('Пусто')}</span>`;
    }

    const badge = e => [
        Number(e.probability ?? 100) < 100 && e.useProbability !== false ? `<b class="lbw-badge" title="${tr('ST бросает кубик при каждой генерации')}">${tr('шанс {0}%', esc(e.probability))}</b>` : '',
        e.group ? `<b class="lbw-badge" title="${tr('Группа включения: из группы попадёт одна запись')}">${tr('группа {0}', esc(e.group))}</b>` : '',
        e.sticky ? `<b class="lbw-badge" title="${tr('После срабатывания держится столько сообщений')}">sticky ${esc(e.sticky)}</b>` : '',
        e.cooldown ? `<b class="lbw-badge" title="${tr('После срабатывания пропускает столько сообщений')}">cooldown ${esc(e.cooldown)}</b>` : '',
    ].join('');
    const rowHTML = (it, why, multi, extraCls = '') => `<div class="lbw-res${extraCls}" data-world="${esc(it.world)}" data-uid="${esc(it.e.uid)}">`
        + `<span class="lbw-dot lbw-${it.e.constant ? 'con' : 'key'}"></span>`
        + `<span class="lbw-res-main"><span>${esc(it.e.comment || 'UID ' + it.e.uid)}${badge(it.e)}</span><span class="lbw-muted">${multi ? esc(it.world) + ' · ' : ''}${esc(why)}</span></span>`
        + `<span class="lbw-res-t">${tokLabel(tokenInfo(it.e.content))}</span></div>`;

    // ---------- keyword simulation (this book / all active) ----------
    async function runKeys(scope) {
        const text = $text.value;
        const ctx = SillyTavern.getContext();
        const { items: raw, activeHasMine } = await collect(scope);
        const items = raw.filter(it => !isSeparator(it.e) || it.e.content);
        lastItems = items;
        requestTokens(items.map(it => it.e.content));
        const { act, blocked } = simulate(items, { text, msgs: chatMsgs, ch: currentCharacter(), chatLen: (ctx.chat || []).length });
        const multi = new Set(items.map(it => it.world)).size > 1;
        const list = how => [...act].filter(([, v]) => v.how === how).map(([it, v]) => ({ it, v }));
        const byKey = list('key'), byRec = list('rec'), cons = list('const').filter(x => x.it.e.content);
        const all = [...byKey, ...byRec, ...cons];
        const tok = arr => tokenSum(arr.map(x => x.it.e.content));
        highlight(text, byKey.map(x => x.it));

        // groups: several activated entries share a group → ST keeps one
        const groups = new Map();
        for (const { it } of all) for (const g of String(it.e.group || '').split(',').map(s => s.trim()).filter(Boolean)) {
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(it);
        }
        const groupNotes = [...groups].filter(([, l]) => l.length > 1)
            .map(([g, l]) => tr('Группа «{0}»: сработали {1}, в промпт попадёт одна ({2}).', g, l.length, l.some(x => x.e.groupOverride) ? tr('с приоритетом группы') : tr('по весу, случайно')));
        // budget: ST spends it from the highest order down
        const budget = wiBudget();
        const spend = [...all].filter(x => !x.it.e.ignoreBudget).sort((a, b) => Number(b.it.e.order) - Number(a.it.e.order));
        let used = 0;
        const over = new Set();
        for (const x of spend) { used += tokenInfo(x.it.e.content).n; if (used > budget) over.add(x.it); }
        const chance = all.filter(x => Number(x.it.e.probability ?? 100) < 100 && x.it.e.useProbability !== false);

        const words = it => [...new Set(keyRanges(it.e, text).map(([s, e]) => text.slice(s, e)))].slice(0, 4).join(', ') || tr('вторичный ключ');
        const via = v => tr('через: ') + (v.via || []).map(x => x.e.comment || 'UID ' + x.e.uid).slice(0, 3).join(', ');
        const why = (x, base) => over.has(x.it) ? base + tr(' · не влезет в бюджет') : base;
        const recNote = !world_info_recursive ? tr('Рекурсия выключена в глобальных настройках.')
            : tr('Ничего. «Не запускать рекурсию» стоит у {0} из {1} записей.', items.filter(it => it.e.preventRecursion && !isSeparator(it.e)).length, items.filter(it => !isSeparator(it.e)).length);
        const total = all.length;
        const blockedList = [...blocked].map(([it, v]) => ({ it, v }));
        const notes = [
            ...groupNotes,
            chance.length ? tr('С шансом меньше 100%: {0}. Каждая из них может и не попасть.', chance.length) : '',
            over.size ? tr('Не влезут в бюджет WI ({0} ток.): {1} {2} с самым низким order.', fmtTokens(budget), over.size, plural(over.size, 'запись', 'записи', 'записей')) : tr('Бюджет WI: {0} ток., занято {1}.', fmtTokens(budget), tokLabel(tok(all))),
            scope !== 'book' && !activeHasMine ? tr('Этот лорбук сейчас не активен в чате, поэтому его записей здесь нет.') : '',
        ].filter(Boolean);
        $out.innerHTML = `
            <div class="lbw-test-sum">${tr('Сработает <b>{0}</b> {1} · {2} ток.', total, plural(total, 'запись', 'записи', 'записей'), tokLabel(tok(all)))}</div>
            ${notes.length ? `<div class="lbw-hint">${notes.map(esc).join('<br>')}</div>` : ''}
            <div class="lbw-res-g"><div class="lbw-sec-h">${tr('По ключам')} <span class="lbw-cnt">${byKey.length} · ${tokLabel(tok(byKey))}</span></div>${byKey.map(x => rowHTML(x.it, why(x, tr('слово: ') + words(x.it)), multi)).join('') || `<span class="lbw-muted">${tr('Ничего')}</span>`}</div>
            <div class="lbw-res-g"><div class="lbw-sec-h">${tr('Подтянуто рекурсией')} <span class="lbw-cnt">${byRec.length} · ${tokLabel(tok(byRec))}</span></div>${byRec.map(x => rowHTML(x.it, why(x, via(x.v)), multi)).join('') || `<span class="lbw-muted">${esc(recNote)}</span>`}</div>
            <div class="lbw-res-g"><div class="lbw-sec-h">${tr('Всегда в промпте')} <span class="lbw-cnt">${cons.length} · ${tokLabel(tok(cons))}</span></div>${cons.map(x => rowHTML(x.it, why(x, tr('константа')), multi)).join('') || `<span class="lbw-muted">${tr('Нет констант')}</span>`}</div>
            ${blockedList.length ? `<div class="lbw-res-g"><div class="lbw-sec-h">${tr('Совпали, но не включатся')} <span class="lbw-cnt">${blockedList.length}</span></div>${blockedList.map(x => rowHTML(x.it, x.v.why, multi, ' lbw-res-off')).join('')}</div>` : ''}
            <p class="lbw-muted lbw-small">${tr('Быстрая проверка по ключам. Шанс, группы и бюджет здесь показаны, но не разыграны; sticky и cooldown зависят от истории чата. Точный результат даёт режим «Как в ST».')}</p>`;
    }

    // ---------- the real thing: ST's own scan, dry run ----------
    async function runST(stale = () => false) {
        const text = $text.value;
        const ctx = SillyTavern.getContext();
        await flush(); // ST reads books from its cache; our edits must be saved there first
        // ST's delay and scan depth count over the whole chat, so the dry run gets the full chat:
        // either as is, or with the typed text as a new message on top of it.
        const all = (ctx.chat || []).filter(m => !m.is_system).map(fmtMsg);
        const msgs = chatMsgs ? all : [...all, text];
        const ch = ctx.characters?.[ctx.characterId];
        const scanData = {
            trigger: 'normal',
            personaDescription: ctx.powerUserSettings?.persona_description || '',
            characterDescription: ch?.description || '',
            characterPersonality: ch?.personality || '',
            characterDepthPrompt: ch?.data?.extensions?.depth_prompt?.prompt || '',
            scenario: ch?.scenario || '',
            creatorNotes: ch?.data?.creator_notes || '',
        };
        let finalScan = null;
        const onScan = args => { finalScan = args; };
        eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScan);
        let res, sorted = [];
        try {
            sorted = await getSortedEntries();
            res = await checkWorldInfo([...msgs].reverse(), promptTokens(), true, scanData);
        } catch (e) {
            console.error('[SLAYlorebooks] dry run failed', e);
            $out.innerHTML = `<div class="lbw-hint">${tr('Не получилось запустить проверку ST, подробности в консоли.')}</div>`;
            return;
        } finally {
            eventSource.removeListener(event_types.WORLDINFO_SCAN_DONE, onScan);
        }
        if (stale()) return; // a newer run started meanwhile; it will write the output
        const keyOf = e => `${e.world}\u0000${e.uid}`;
        const activated = [...(res?.allActivatedEntries || [])];
        const activatedKeys = new Set(activated.map(keyOf));
        const items = sorted.map(e => ({ e, world: e.world }));
        lastItems = items;
        requestTokens(items.map(it => it.e.content));
        const multi = new Set(items.map(it => it.world)).size > 1;
        const activeHasMine = sorted.some(e => e.world === store.name);

        // what the keywords alone would have picked, to explain the differences
        const sim = simulate(items, { text, msgs: chatMsgs, ch: currentCharacter(), chatLen: (ctx.chat || []).length });
        const simKey = new Map([...sim.act].map(([it, v]) => [keyOf(it.e), v]));
        const blockedKey = new Map([...sim.blocked].map(([it, v]) => [keyOf(it.e), v]));
        highlight(text, [...sim.act].filter(([, v]) => v.how === 'key').map(([it]) => it).filter(it => activatedKeys.has(keyOf(it.e))));

        const howOf = e => {
            const v = simKey.get(keyOf(e));
            if (e.constant) return tr('константа');
            if (v?.how === 'key') return tr('по ключу');
            if (v?.how === 'rec') return tr('через рекурсию');
            if (e.sticky) return tr('sticky: держится с прошлых сообщений');
            if (e.vectorized) return tr('векторный поиск');
            return tr('по другой причине (декоратор, внешний модуль)');
        };
        const overflowed = !!finalScan?.budget?.overflowed;
        const reasonOf = (e, v) => {
            const r = [];
            if (Number(e.probability ?? 100) < 100 && e.useProbability !== false) r.push(tr('шанс {0}% не выпал', e.probability));
            if (e.group) r.push(tr('группа «{0}»: выбрана другая запись', e.group));
            if (e.cooldown) r.push(tr('возможно, cooldown после прошлого срабатывания'));
            if (Array.isArray(e.triggers) && e.triggers.length && !e.triggers.includes('normal')) r.push(tr('включается только для других типов генерации'));
            if (overflowed) r.push(tr('могла не влезть в бюджет WI'));
            return r.length ? r.join(' · ') : (v?.how === 'rec' ? tr('рекурсия в ST дошла иначе') : tr('отсеяна правилами ST (таймеры, декораторы)'));
        };
        const inPrompt = activated.map(e => ({ it: { e, world: e.world } }));
        const missed = [...simKey].filter(([k]) => !activatedKeys.has(k))
            .map(([k, v]) => ({ it: items.find(it => keyOf(it.e) === k), v })).filter(x => x.it);
        const blocked = [...blockedKey].filter(([k]) => !activatedKeys.has(k))
            .map(([k, v]) => ({ it: items.find(it => keyOf(it.e) === k), v })).filter(x => x.it);
        const tok = tokenSum(activated.map(e => e.content));
        const budget = finalScan?.budget?.current ?? wiBudget();
        const notes = [
            overflowed ? tr('Бюджет WI ({0} ток.) переполнен: часть записей ST отбросил.', fmtTokens(budget)) : tr('Бюджет WI: {0} ток.', fmtTokens(budget)),
            !activeHasMine ? tr('Этот лорбук сейчас не активен в чате: ST его не сканирует.') : '',
            ctx.groupId ? tr('Групповой чат: фильтр персонажей ST проверяет по всем участникам.') : '',
        ].filter(Boolean);
        $out.innerHTML = `
            <div class="lbw-test-sum">${tr('ST вставит <b>{0}</b> {1} · {2} ток.', activated.length, plural(activated.length, 'запись', 'записи', 'записей'), tokLabel(tok))}</div>
            <div class="lbw-hint">${notes.map(esc).join('<br>')}<br>${tr('Это настоящая проверка ST «вхолостую»: сообщения и таймеры не меняются. Шанс бросается заново при каждом прогоне, нажми «Ещё раз».')}</div>
            <div class="lbw-res-g"><div class="lbw-sec-h">${tr('Попадут в промпт')} <span class="lbw-cnt">${activated.length} · ${tokLabel(tok)}</span></div>${inPrompt.map(x => rowHTML(x.it, howOf(x.it.e), multi)).join('') || `<span class="lbw-muted">${tr('Ничего')}</span>`}</div>
            ${missed.length ? `<div class="lbw-res-g"><div class="lbw-sec-h">${tr('Совпали по ключам, но не попали')} <span class="lbw-cnt">${missed.length}</span></div>${missed.map(x => rowHTML(x.it, reasonOf(x.it.e, x.v), multi, ' lbw-res-off')).join('')}</div>` : ''}
            ${blocked.length ? `<div class="lbw-res-g"><div class="lbw-sec-h">${tr('Отсеяны фильтром или delay')} <span class="lbw-cnt">${blocked.length}</span></div>${blocked.map(x => rowHTML(x.it, x.v.why, multi, ' lbw-res-off')).join('')}</div>` : ''}`;
    }

    const fmtMsg = m => (world_info_include_names ? `${m.name}: ` : '') + m.mes;
    let runJob = 0;
    async function run() {
        const job = ++runJob;
        p.testText = $text.value === SAMPLE ? '' : $text.value; savePrefs();
        showSource();
        const scope = $scope.value;
        if (scope === 'st') await runST(() => job !== runJob); else await runKeys(scope);
    }
    const runSoon = debounce(run, 250);

    $text.addEventListener('input', () => { chatMsgs = null; runSoon(); });
    $scope.addEventListener('change', () => { p.testScope = $scope.value; savePrefs(); run(); });
    $n.addEventListener('change', () => { p.testN = Math.max(1, Number($n.value) || 2); savePrefs(); });
    el.addEventListener('click', ev => {
        if (ev.target.closest('[data-act="chat"]')) {
            const ctx = SillyTavern.getContext();
            const n = Math.max(1, Number($n.value) || 2);
            const msgs = (ctx.chat || []).filter(m => !m.is_system).slice(-n);
            if (!msgs.length) { toastr.info(tr('В открытом чате нет сообщений')); return; }
            chatMsgs = msgs.map(fmtMsg);
            $text.value = chatMsgs.join('\n');
            run();
            return;
        }
        if (ev.target.closest('[data-act="rerun"]')) { run(); return; }
        const res = ev.target.closest('.lbw-res');
        if (res) onOpen(res.dataset.world, Number(res.dataset.uid));
    });

    return { run, get items() { return lastItems; } };
}
