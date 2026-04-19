/* AgentClub UI kit — small visual primitives shared by chat.js and the
 * admin/login templates. Two things live here:
 *
 *   1. ICONS / iconHTML(name, opts)
 *      A trimmed subset of Lucide Icons (https://lucide.dev, ISC license).
 *      We inline only the icons we actually use to keep payload tiny.
 *      Stroke-width / size / color all flow from the host CSS via
 *      `currentColor` and the .icon class, so the icons match button
 *      text automatically.
 *
 *   2. avatarColor(seed) / applyAvatarBg(el, seed)
 *      Stable per-name hash → one of 8 calm palette colours. Replaces
 *      the old "everyone gets the same pink gradient" default avatar so
 *      the chat list looks like a real product, not a template.
 */

(function (global) {
    "use strict";

    // ── Icons ──────────────────────────────────────────────────────────
    // Each value is the inner-SVG (paths, etc.) of a 24×24 lucide icon
    // with stroke-linecap=round / stroke-linejoin=round. The wrapper
    // <svg> is added by iconHTML() so all icons share size/stroke rules.
    const ICONS = {
        plus:        '<path d="M12 5v14"/><path d="M5 12h14"/>',
        x:           '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        menu:        '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
        users:       '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        image:       '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
        paperclip:   '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
        settings:    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
        // Generic message bubble — used as the empty-state hero.
        'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        // File-type icons. We keep these minimal — Lucide ships dedicated
        // file-text/file-spreadsheet/etc but the visual difference is so
        // subtle at small sizes it's not worth the extra bytes.
        'file':        '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
        'file-text':   '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
        'file-spreadsheet': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
        'file-archive':'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="20" r="2"/><path d="M10 7V5"/><path d="M10 11V9"/><path d="M10 15v-2"/><path d="M10 18v-1"/>',
        'arrow-left':  '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
        'arrow-up':    '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
        loader:        '<path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/>',
        'log-out':     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    };

    /**
     * Return an inline SVG string for the named icon.
     * @param {string} name  Key in ICONS.
     * @param {object} [opts]
     * @param {string} [opts.cls]    Extra CSS class on the <svg>.
     * @param {number|string} [opts.size]  Pixel size, e.g. 18. Defaults to "1em" via .icon.
     * @param {string} [opts.title]  Optional <title> for accessibility.
     * @returns {string}
     */
    function iconHTML(name, opts) {
        const body = ICONS[name];
        if (!body) {
            console.warn('[ui-kit] unknown icon:', name);
            return '';
        }
        const o = opts || {};
        const cls = 'icon' + (o.cls ? ' ' + o.cls : '');
        const sizeAttr = o.size != null
            ? ` width="${o.size}" height="${o.size}"`
            : '';
        const title = o.title
            ? `<title>${String(o.title).replace(/[<>&"]/g, c =>
                ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</title>`
            : '';
        return `<svg class="${cls}"${sizeAttr} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="${o.title ? 'false' : 'true'}">${title}${body}</svg>`;
    }

    // ── Avatar palette ─────────────────────────────────────────────────
    // Calm, mid-saturation colours picked to read well on white at both
    // 32px (chat list) and 80px (settings modal) sizes. Order matters —
    // adjacent letters (alice/bob/carol) should generally land on
    // visually distinguishable hues.
    const AVATAR_PALETTE = [
        '#3370FF', // blue (matches --color-primary)
        '#00B96B', // green
        '#F5A623', // amber
        '#E94B6A', // coral
        '#7B5BFF', // violet
        '#0BA5EC', // sky
        '#FB7C24', // orange
        '#5E6AD2', // indigo
    ];

    function avatarColor(seed) {
        const s = String(seed || '');
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
            // djb2 — simple, well-distributed for short strings.
            h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        }
        return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
    }

    /** Inline-style applier for cases where you build HTML strings. */
    function avatarStyle(seed) {
        return `background:${avatarColor(seed)}`;
    }

    /**
     * Walk the document and replace every `<element data-icon="name">`
     * with the corresponding inline SVG. Lets templates be declarative
     * (`<button data-icon="users"></button>`) instead of pasting raw SVG
     * markup. Re-runnable on dynamic HTML — pass a root element.
     */
    function mountIcons(root) {
        const scope = root || document;
        const els = scope.querySelectorAll('[data-icon]');
        for (const el of els) {
            const name = el.dataset.icon;
            if (!name) continue;
            // Don't double-mount: if the element already starts with an
            // <svg> from a previous pass, skip.
            if (el.firstElementChild && el.firstElementChild.tagName === 'svg') continue;
            // Preserve any text content (e.g. button label after icon).
            const trailing = el.innerHTML;
            el.innerHTML = iconHTML(name) + (trailing ? ' ' + trailing : '');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => mountIcons());
    } else {
        mountIcons();
    }

    global.AgentClubUI = {
        ICONS,
        iconHTML,
        avatarColor,
        avatarStyle,
        mountIcons,
        AVATAR_PALETTE,
    };
})(window);
