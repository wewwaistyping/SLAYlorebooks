// <lbw-select>: a light stand-in for <select>. In Chrome a native <select> inside a shadow root adds ~17 ms
// to every layout of the tree (measured on SillyTavern's page), so the extension uses this instead.
// Markup stays select-like: <lbw-select data-f="mode" value="normal"><option value="normal">…</option></lbw-select>.
// It exposes .value / .disabled / .options and fires a bubbling 'change' event.

let openMenu = null;

function closeMenu() {
    if (!openMenu) return;
    openMenu.menu.remove();
    openMenu.owner.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onResize);
    openMenu.root.removeEventListener('scroll', onScroll, true);
    openMenu = null;
}

/** The page under the menu scrolled: close it. Scrolling the menu's own list must not. */
function onScroll(ev) {
    if (openMenu && !openMenu.menu.contains(ev.target)) closeMenu();
}

/** A phone keyboard sliding away changes only the height; that must not close a menu that has just opened. */
function onResize() {
    if (openMenu && window.innerWidth !== openMenu.width) closeMenu();
}

function onOutside(ev) {
    if (!openMenu) return;
    const path = ev.composedPath();
    if (path.includes(openMenu.menu) || path.includes(openMenu.owner)) return;
    closeMenu();
}

class LbwSelect extends HTMLElement {
    connectedCallback() {
        if (this._ready) { this._paint(); return; }
        this._ready = true;
        if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
        this.setAttribute('role', 'combobox');
        this.setAttribute('aria-expanded', 'false');
        this._label = document.createElement('span');
        this._label.className = 'lbw-sel-label';
        this.prepend(this._label);
        if (!this.hasAttribute('value')) {
            const pre = this.querySelector('option[selected]') || this.querySelector('option');
            if (pre) this.setAttribute('value', pre.value);
        }
        this._paint();
        this.addEventListener('click', ev => {
            if (ev.target.closest('.lbw-menu')) return;
            if (this.disabled) return;
            if (openMenu?.owner === this) closeMenu(); else this._open();
        });
        this.addEventListener('keydown', ev => this._key(ev));
    }

    /** Replaces the options; keeps the value when it still exists. */
    setOptionsHTML(html) {
        this.querySelectorAll('option').forEach(o => o.remove());
        this.insertAdjacentHTML('beforeend', html);
        if (!this.options.some(o => o.value === this.value)) this.setAttribute('value', this.options[0]?.value ?? '');
        this._paint();
    }

    get options() { return [...this.querySelectorAll('option')]; }
    get selectedOptions() { return this.options.filter(o => o.value === this.value); }
    get value() { return this.getAttribute('value') ?? ''; }
    set value(v) { this.setAttribute('value', String(v)); this._paint(); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(on) { this.toggleAttribute('disabled', !!on); this.tabIndex = on ? -1 : 0; }

    _paint() {
        if (!this._label) return;
        const o = this.options.find(x => x.value === this.value) || this.options[0];
        this._label.textContent = o ? o.textContent : '';
    }

    _set(v) {
        if (v === this.value) return;
        this.value = v;
        this.dispatchEvent(new Event('change', { bubbles: true }));
    }

    _open() {
        closeMenu();
        const root = this.getRootNode();
        const menu = document.createElement('div');
        menu.className = 'lbw-menu';
        menu.setAttribute('role', 'listbox');
        for (const o of this.options) {
            if (o.hidden) continue;
            const item = document.createElement('div');
            item.className = 'lbw-menu-item' + (o.value === this.value ? ' lbw-on' : '');
            item.setAttribute('role', 'option');
            item.dataset.value = o.value;
            item.textContent = o.textContent;
            menu.appendChild(item);
        }
        menu.addEventListener('click', ev => {
            const it = ev.target.closest('.lbw-menu-item');
            if (!it) return;
            closeMenu();
            this._set(it.dataset.value);
            this.focus();
        });
        // The extension host has contain:strict, so the menu is positioned inside .lbw-app, not the viewport.
        const box = root.querySelector?.('.lbw-app') || document.body;
        box.appendChild(menu);
        const b = box.getBoundingClientRect();
        const r = this.getBoundingClientRect();
        menu.style.minWidth = Math.round(r.width) + 'px';
        const left = Math.max(4, Math.min(r.left - b.left, b.width - menu.offsetWidth - 4));
        menu.style.left = Math.round(left) + 'px';
        const below = b.bottom - r.bottom - 8;
        const above = r.top - b.top - 8;
        const h = Math.min(menu.scrollHeight, 320);
        if (below >= Math.min(h, 160) || below >= above) {
            menu.style.top = Math.round(r.bottom - b.top + 2) + 'px';
            menu.style.maxHeight = Math.max(100, Math.min(320, below)) + 'px';
        } else {
            const mh = Math.min(320, above);
            menu.style.maxHeight = mh + 'px';
            menu.style.top = Math.round(r.top - b.top - 2 - Math.min(h, mh)) + 'px';
        }
        menu.querySelector('.lbw-on')?.scrollIntoView({ block: 'nearest' });
        this.setAttribute('aria-expanded', 'true');
        openMenu = { owner: this, menu, root: root.querySelector?.('.lbw-app') || document, width: window.innerWidth };
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', onResize);
        openMenu.root.addEventListener('scroll', onScroll, true);
    }

    _key(ev) {
        if (this.disabled) return;
        const opts = this.options.filter(o => !o.hidden);
        const i = opts.findIndex(o => o.value === this.value);
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const n = opts[Math.max(0, Math.min(opts.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
            if (n) {
                this._set(n.value);
                if (openMenu?.owner === this) { closeMenu(); this._open(); }
            }
        } else if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            if (openMenu?.owner === this) closeMenu(); else this._open();
        } else if (ev.key === 'Escape' && openMenu?.owner === this) {
            ev.preventDefault();
            ev.stopPropagation();
            closeMenu();
        }
    }

    disconnectedCallback() { if (openMenu?.owner === this) closeMenu(); }
}

if (!customElements.get('lbw-select')) customElements.define('lbw-select', LbwSelect);
