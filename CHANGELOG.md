# История версий · Version history

## 0.5.5 — 2026-11-19

- Кнопка "Аа→ regex" над ключами и вторичными ключами: все обычные ключи записи разом становятся regex со склонениями. Уже готовые regex и ключи с макросами не меняются. Нажатие на такой ключ открывает выбор окончаний, жёлтая точка отмечает слова, где склонение не угадать. "Вернуть как было" отменяет всё.
- В конструкторе новый тип "на -ь, как Ночь": раньше такие слова склонялись как "Конь". Слова на -о и -е (Небо, Море) больше не получают лишних окончаний.
- "Аа→ regex" button above the keys and the secondary keys: every plain key of the entry becomes a regex with endings at once. Keys that are already regex and keys with macros stay as they are. Clicking such a key shows the endings to choose from; a yellow dot marks words whose declension cannot be guessed. "Undo" reverts the whole step.
- The builder has a new type for words in -ь like Ночь, which used to decline like Конь. Words in -о and -е (Небо, Море) no longer get wrong endings.

## 0.5.4 — 2026-11-18

- Массовая правка: когда отмечено две записи и больше, справа сразу открываются настройки для всех выбранных, а не форма одной записи. Режим, позиция и шанс показывают то, что стоит у выбранных, или «разные».
- Пустой шанс в массовой правке больше не ставит 0%.
- Импорт файла с именем открытого лорбука: панель перечитывает его, следующая правка не затирает импорт.
- Значения из чужого лорбука (глубина, sticky, cooldown, шанс, UID) выводятся только как текст.
- Точные токены в списке видны сразу после перезагрузки страницы.
- Телефон: «+ Запись» открывает форму новой записи.
- Другая запись открывается с начала формы; клик по соседнему ключу не теряется, пока редактируется другой.
- Bulk edit: with two or more entries ticked the right side shows the settings for all of them instead of one entry's form. Mode, position and chance show what the ticked entries have, or "mixed".
- An empty chance in bulk edit no longer sets 0%.
- Importing a file named like the open lorebook: the panel reads it again, so the next edit does not overwrite the import.
- Values from someone else's lorebook (depth, sticky, cooldown, chance, UID) are shown as text only.
- Exact token counts appear in the list right after a page reload.
- Phones: "+ Entry" opens the new entry's form.
- Another entry opens from the top of the form; a click on a neighbouring key is not lost while another one is being edited.

## 0.5.3 — 2026-11-13

- Новая иконка: книга с искрой вместо 🛠 у выбора лорбука и в заголовке настроек. Искра розовая, когда расширение включено.
- Заголовок в «Расширениях» оформлен надписью SLAY, в списке расширений название с 💅.
- New icon: a book with a spark instead of 🛠 next to the lorebook selector and in the settings header. The spark turns pink while the extension is on.
- The header in "Extensions" uses the SLAY wordmark; the extension list shows the name with 💅.

## 0.5.2 — 2026-11-13

- Правка, набранная во время сохранения, больше не теряется. На телефоне правки сохраняются и при сворачивании браузера.
- Выключение расширения снова обновляет родной список таверны.
- Название записи не теряет курсор, когда запись становится папкой.
- Быстрее на больших лорбуках и телефонах: кнопки ↑↓, поиск, открытие лорбука; точные токены появляются по мере подсчёта.
- Телефоны: ключ, набранный без Enter, сохраняется; списки не закрываются из-за клавиатуры; поиск лорбука в окне переноса работает на iPhone.
- При переходе в родной список таверны открыта та же запись, и обратно.
- Таверна загружает один файл `bundle.js` вместо двадцати; клики внутри панели не тормозят остальную страницу.
- An edit typed while a save is in flight is no longer lost; phones also save when the browser goes to the background.
- Switching the extension off refreshes the native list again. The title keeps the cursor when an entry becomes a folder.
- Faster on large lorebooks and phones: step buttons, search, opening a lorebook; exact token counts appear as they are counted.
- Phones: a key typed without Enter is kept, menus survive the keyboard closing, the lorebook search in the transfer window works on iPhone.
- Switching to the native list keeps the open entry open, and back.
- SillyTavern loads one file, `bundle.js`, instead of twenty; clicks inside the panel no longer slow down the rest of the page.

## 0.5.1 — 2026-11-04

- Ширину окна на ПК можно менять: потянуть за край или выбрать размер в настройках. Там же кнопка сброса.
- Window width on PC can be changed: drag an edge or pick a size in the settings, which also have a reset button.

## 0.5.0 — 2026-11-04

Первая публичная версия. Что умеет расширение, написано в [README](README.md).

First public release. See the [README](README.en.md) for what it does.
