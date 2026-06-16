/**
 * Sort Attachments — Digital Editor Sidebar Panel Plugin
 *
 * Adds a "Sort Attachments" sidebar panel to the Studio Digital Editor.
 * The native "Attachments" panel has no documented hook for injecting
 * controls directly into it, so this plugin instead provides its own
 * panel that lists the same attachments (images/video/audio contained
 * in the current article's dossier) with a manual sort control.
 *
 * Behavior (confirmed requirements):
 *   - Sorting is manual only — nothing changes until the "Sort" button
 *     is clicked. Selecting a sort key alone does not reorder anything.
 *   - On click, the list in THIS panel re-sorts and re-renders instantly
 *     (pure client-side reorder of data already loaded — no server
 *     round-trip needed for the visual update, so it's "live" with no
 *     added server load).
 *   - In the background, the new order is also written back to the
 *     server (Relation.Order on each Image/Video/Audio "Contained"
 *     relation under the dossier) via a single batched
 *     UpdateObjectRelations call, so the native Attachments panel will
 *     reflect the new order the next time it loads/refreshes.
 *   - Sort by Name, Type, Date created, and Date modified are
 *     implemented. "Date added to dossier" specifically is NOT
 *     possible: the Relation entity (the link between a dossier and
 *     its attachments) has no timestamp field at all in the v10.64
 *     Workflow SDK docs — its only properties are Parent, Child,
 *     Type, Placements, ParentVersion/ChildVersion, Rating, Targets,
 *     ParentInfo/ChildInfo, ObjectLabels, and Order. "Created" and
 *     "Modified" instead come from each attachment's OWN
 *     WorkflowMetaData (when the image/video/audio file itself was
 *     created/last modified in Studio) — not when it was added to
 *     THIS dossier. For freshly ingested assets the two are usually
 *     the same day, but for an older asset re-added to a new
 *     dossier they will differ.
 *
 * Digital Editor SDK APIs used (per the team's existing
 * sync-print-to-digital-sidepanel.js example):
 *   - DigitalEditorSdk.onOpenArticle()
 *   - SDKArticle.addSidebarPanel()
 *   - SDKArticle.checkMetadata()   → get the open article's ID
 *   - ContentStationSdk.getInfo() → server URL + ticket for JSON-RPC calls
 *
 * Server calls (Workflow interface, JSON-RPC, same pattern as the
 * example plugin):
 *   - GetObjects (RequestInfo: ['Relations'])
 *       1) on the open article's ID, to find its parent dossier
 *          (the Relation where this article is the Child and
 *          Type === 'Contained')
 *       2) on the dossier's ID, to list its contained children
 *          (Relations where the dossier is the Parent), filtered to
 *          Image/Video/Audio types
 *   - UpdateObjectRelations — writes new Order values back onto the
 *     dossier's "Contained" relations after a manual sort
 *   - GetObjects (on the attachment IDs themselves, no RequestInfo
 *     restriction so the server's default MetaData is returned) —
 *     used only to read MetaData.WorkflowMetaData.Created/Modified
 *     for the "Date created" / "Date modified" sort options.
 *
 * ⚠ ASSUMPTIONS THAT NEED LIVE VERIFICATION IN STUDIO ⚠
 * The v10.64.2 SDK docs provided describe the Workflow data model
 * (Relation/Attachment entities, services and their parameters) but
 * do not include literal JSON-RPC request/response examples, so a
 * few specifics below are best-effort and may need small adjustments
 * once tested against a real Studio instance (check the browser
 * console — every step logs under the "[sort-attachments]" tag):
 *   1. The exact shape of a GetObjects JSON-RPC response (this code
 *      tries result.Objects[0].Relations first, with fallbacks —
 *      see getRelationsFromResult()).
 *   2. That checkMetadata() returns the open object's ID at
 *      metadata.MetaData.BasicMetaData.ID (confirmed shape used by
 *      the example plugin for this same field).
 *   3. That images/video/audio shown in the Attachments panel are
 *      reachable via Relation.Type === 'Contained' with the dossier
 *      as Parent (rather than e.g. being attached directly to the
 *      article, or via a different relation type).
 *   4. That UpdateObjectRelations accepts a partial Relation
 *      (Parent + Child + Type + Order) to update just the Order
 *      field — if the server requires the full original Relation
 *      object instead, the relations fetched in step 2 are passed
 *      through unmodified except for Order, which should cover this
 *      either way.
 *   5. That the native Attachments panel actually reads display order
 *      from Relation.Order. This is the strongest candidate found in
 *      the docs (added in v10.63, "Order of the child object in
 *      relation to the parent context") but isn't explicitly
 *      documented as driving that specific panel's UI.
 *   6. That WorkflowMetaData.Created/Modified are returned in the
 *      documented "yyyy-mm-dd@hh:mm:ss" format for every attachment
 *      type (Image/Video/Audio) — this code sorts the raw strings
 *      lexically, which is safe as long as that fixed-width format
 *      holds, with no timezone normalization needed/possible since
 *      the docs don't specify a timezone for this value.
 */
(function () {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────
    const CONFIG = {
        panelTooltip: 'Sort Attachments',

        // Object types treated as "attachments" for sorting purposes.
        attachmentTypes: ['Image', 'Video', 'Audio'],

        // Relation type linking an attachment to its parent dossier.
        containedRelationType: 'Contained',
    };

    // ── Logging ─────────────────────────────────────────────────────────
    const LOG = '[sort-attachments]';
    const log = (...a) => console.log(LOG, ...a);
    const logWarn = (...a) => console.warn(LOG, ...a);
    const logError = (...a) => console.error(LOG, ...a);

    // ── Server helpers (same pattern as sync-print-to-digital-sidepanel.js) ──
    let _serverUrl = '';
    let _ticket = '';

    function initServerInfo() {
        const info = ContentStationSdk.getInfo();
        const si = info.ServerInfo || {};
        const raw = si.URL || si.Url || si.url || '';
        _serverUrl = raw.replace(/\/index\.php\/?$/, '');
        _ticket = info.Ticket || '';
        log('Server:', _serverUrl, 'ticket:', _ticket ? '***' : '(cookie auth)');
    }

    async function wflCall(method, params) {
        const url = `${_serverUrl}/index.php?protocol=JSON&method=${encodeURIComponent(method)}`;
        const req = { ...params };
        if (_ticket) req.Ticket = _ticket;

        const body = {
            id: Date.now(),
            jsonrpc: '2.0',
            method,
            params: { protocol: 'JSON', req },
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-woodwing-application': 'Content Station' },
            credentials: 'include',
            body: JSON.stringify(body),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message || 'Server error');
        return data.result;
    }

    // ── Defensive parsing of GetObjects results ──────────────────────────
    // See assumption #1 above — logs the raw shape on first failure so it
    // can be adjusted quickly against a live response.
    function getObjectsFromResult(result) {
        if (Array.isArray(result?.Objects)) return result.Objects;
        if (result?.Object) return [result.Object];
        if (Array.isArray(result?.Rows)) return result.Rows;
        logWarn('Unexpected GetObjects response shape, raw result:', result);
        return [];
    }

    function getRelationsFromObject(obj) {
        if (Array.isArray(obj?.Relations)) return obj.Relations;
        if (Array.isArray(obj?.RelationsInfo?.Relations)) return obj.RelationsInfo.Relations;
        logWarn('Unexpected object shape (no Relations array found):', obj);
        return [];
    }

    function objectInfoId(info) {
        return info?.ID ?? info?.Id ?? info?.id ?? null;
    }
    function objectInfoName(info) {
        return info?.Name ?? info?.BasicMetaData?.Name ?? 'Untitled';
    }
    function objectInfoType(info) {
        return info?.Type ?? info?.BasicMetaData?.Type ?? '';
    }

    // ── Step 1: find the parent dossier of the open article ──────────────
    async function findDossierId(articleId) {
        const result = await wflCall('GetObjects', {
            IDs: [articleId],
            Lock: false,
            Rendition: 'none',
            RequestInfo: ['Relations'],
        });
        const objects = getObjectsFromResult(result);
        if (!objects.length) {
            throw new Error('Could not load the open article’s relations.');
        }
        const relations = getRelationsFromObject(objects[0]);

        // The article should appear as the Child of a 'Contained' relation
        // whose Parent is the dossier.
        const containedIn = relations.find((rel) => {
            const isContained = rel.Type === CONFIG.containedRelationType;
            const childId = rel.Child ?? rel.ChildID ?? objectInfoId(rel.ChildInfo);
            return isContained && String(childId) === String(articleId);
        });

        if (!containedIn) {
            logWarn('No Contained-parent relation found for article. Raw relations:', relations);
            throw new Error('This article does not appear to be contained in a dossier.');
        }

        const dossierId = containedIn.Parent ?? containedIn.ParentID ?? objectInfoId(containedIn.ParentInfo);
        if (!dossierId) {
            throw new Error('Found a containing relation but could not read the dossier ID.');
        }
        log('Resolved dossier ID:', dossierId);
        return String(dossierId);
    }

    // ── Step 2: fetch the dossier's image/video/audio attachments ────────
    async function fetchAttachments(dossierId) {
        const result = await wflCall('GetObjects', {
            IDs: [dossierId],
            Lock: false,
            Rendition: 'none',
            RequestInfo: ['Relations'],
        });
        const objects = getObjectsFromResult(result);
        if (!objects.length) {
            throw new Error('Could not load the dossier’s relations.');
        }
        const relations = getRelationsFromObject(objects[0]);

        const items = [];
        relations.forEach((rel, idx) => {
            if (rel.Type !== CONFIG.containedRelationType) return;
            const parentId = rel.Parent ?? rel.ParentID ?? objectInfoId(rel.ParentInfo);
            if (String(parentId) !== String(dossierId)) return;

            const childId = rel.Child ?? rel.ChildID ?? objectInfoId(rel.ChildInfo);
            const type = objectInfoType(rel.ChildInfo);
            if (!CONFIG.attachmentTypes.includes(type)) return;

            items.push({
                childId: String(childId),
                name: objectInfoName(rel.ChildInfo),
                type,
                order: typeof rel.Order === 'number' ? rel.Order : idx + 1,
                relation: rel, // kept so we can write back Order with minimal field loss
            });
        });

        // Show in current (server) order by default.
        items.sort((a, b) => a.order - b.order);
        log('Found', items.length, 'attachment(s) on dossier', dossierId);
        return items;
    }

    // ── Step 2b: fetch each attachment's own Created/Modified dates ──────
    // (best-effort — not required for the panel to function; only needed
    // to enable the "Date created" / "Date modified" sort options.)
    async function fetchAttachmentDates(items) {
        if (!items.length) return;
        const result = await wflCall('GetObjects', {
            IDs: items.map((item) => item.childId),
            Lock: false,
            Rendition: 'none',
        });
        const objects = getObjectsFromResult(result);
        const byId = new Map();
        objects.forEach((obj) => {
            const id = obj?.MetaData?.BasicMetaData?.ID;
            if (id) byId.set(String(id), obj.MetaData?.WorkflowMetaData || {});
        });
        items.forEach((item) => {
            const wf = byId.get(item.childId);
            item.created = (wf && wf.Created) || null;
            item.modified = (wf && wf.Modified) || null;
        });
        log('Loaded created/modified dates for', byId.size, 'of', items.length, 'attachment(s)');
    }

    // ── Step 3: persist new order back to the server ─────────────────────
    async function persistOrder(items) {
        const relations = items.map((item, idx) => ({
            ...item.relation,
            Parent: item.relation.Parent ?? item.relation.ParentID,
            Child: item.relation.Child ?? item.relation.ChildID,
            Type: CONFIG.containedRelationType,
            Order: idx + 1,
        }));
        await wflCall('UpdateObjectRelations', { Relations: relations });
    }

    // ── Sorting ────────────────────────────────────────────────────────
    function sortItems(items, key) {
        const copy = items.slice();
        if (key === 'name') {
            copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
        } else if (key === 'type') {
            copy.sort((a, b) => {
                const t = a.type.localeCompare(b.type);
                return t !== 0 ? t : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
            });
        } else if (key === 'created' || key === 'modified') {
            // Dates come back as fixed-width "yyyy-mm-dd@hh:mm:ss" strings,
            // which sort correctly with plain lexical comparison. Items
            // with no date (fetch failed/missing) sort to the end.
            copy.sort((a, b) => {
                const av = a[key] || '';
                const bv = b[key] || '';
                if (!av && !bv) return 0;
                if (!av) return 1;
                if (!bv) return -1;
                return av < bv ? -1 : av > bv ? 1 : 0;
            });
        }
        return copy;
    }

    const SORT_LABELS = {
        name: 'name',
        type: 'type',
        created: 'date created',
        modified: 'date modified',
    };

    // ── Panel markup ───────────────────────────────────────────────────
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function typeIcon(type) {
        if (type === 'Video') return '\u{1F3AC}'; // 🎬
        if (type === 'Audio') return '\u{1F3B5}'; // 🎵
        return '\u{1F5BC}'; // 🖼
    }

    function buildPanelHTML() {
        return `
<!DOCTYPE html>
<html>
<head>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: Mulish, Helvetica, Arial, sans-serif;
        font-size: 13px;
        color: #333;
        padding: 21px;
        background: #fff;
        overflow-y: auto;
        line-height: 1.5;
    }

    /* ── Panel title — matches "Image", "Attachments" native headers ── */
    .panel-title { font-size: 18px; font-weight: 700; color: #333; margin-bottom: 6px; }
    .panel-subtitle { font-size: 12px; color: #888; margin-bottom: 20px; }

    .field-label {
        display: block;
        font-size: 13px;
        font-weight: 400;
        color: #333;
        margin-bottom: 5px;
        margin-top: 16px;
    }

    select {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid #ccc;
        border-radius: 3px;
        font-size: 13px;
        font-family: inherit;
        color: #333;
        background: #fff;
    }
    select:focus { outline: none; border-color: #f8b558; }
    select:disabled { color: #999; background: #f5f5f5; }

    .btn {
        display: block;
        width: 100%;
        padding: 8px 12px;
        border: 1px solid #ccc;
        border-radius: 3px;
        font-size: 13px;
        font-family: inherit;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        transition: background 0.15s;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    #btn-sort.btn {
        margin-top: 16px;
        background: #f8b558 !important;
        color: #333333 !important;
        border: 2px solid #f8b558 !important;
        border-radius: 5px !important;
        font-weight: 700;
        min-height: 28px;
        padding: 0 14px;
    }
    #btn-sort.btn:hover:not(:disabled) { background: #f0a848 !important; border-color: #f0a848 !important; }

    .status {
        margin-top: 12px;
        padding: 8px 10px;
        border-radius: 3px;
        font-size: 12px;
        display: none;
        line-height: 1.4;
    }
    .status.info    { display: block; background: #fef8ee; color: #7a5a00; }
    .status.error   { display: block; background: #fff0f0; color: #a00; }
    .status.success { display: block; background: #f0fff0; color: #060; }

    .attachment-list { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e0e0e0; }

    .attachment-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        margin-bottom: 4px;
        border-radius: 3px;
        background: #fafafa;
        font-size: 12px;
    }
    .attachment-index { color: #aaa; font-weight: 600; min-width: 18px; text-align: right; }
    .attachment-icon { flex-shrink: 0; }
    .attachment-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #333;
    }
    .attachment-type {
        flex-shrink: 0;
        font-size: 11px;
        color: #666;
        background: #eee;
        border-radius: 10px;
        padding: 2px 8px;
    }
    .empty-hint, .loading-hint { color: #888; font-style: italic; font-size: 12px; }
</style>
</head>
<body>
    <div class="panel-title">Sort Attachments</div>
    <div class="panel-subtitle">Sorts this dossier's image/video/audio attachments. Nothing changes until you click Sort.</div>

    <label class="field-label" for="sort-key">Sort by</label>
    <select id="sort-key" disabled>
        <option value="name">Name (A–Z)</option>
        <option value="type">Type</option>
        <option value="created" id="opt-created" disabled>Date created (oldest first)</option>
        <option value="modified" id="opt-modified" disabled>Date modified (oldest first)</option>
    </select>

    <button id="btn-sort" class="btn" disabled>Sort</button>

    <div id="status" class="status"></div>

    <div id="attachment-list" class="attachment-list">
        <div class="loading-hint">Loading attachments…</div>
    </div>
</body>
</html>`;
    }

    // ── Main ───────────────────────────────────────────────────────────
    DigitalEditorSdk.onOpenArticle(async function (article) {
        log('Article opened');
        initServerInfo();

        let panelDoc = null;
        let attachmentItems = [];
        let lastSortKey = null;

        function setStatus(type, message) {
            if (!panelDoc) return;
            const el = panelDoc.getElementById('status');
            el.className = 'status ' + type;
            el.textContent = message;
        }

        function clearStatus() {
            if (!panelDoc) return;
            panelDoc.getElementById('status').className = 'status';
        }

        function renderList() {
            if (!panelDoc) return;
            const list = panelDoc.getElementById('attachment-list');
            if (!attachmentItems.length) {
                list.innerHTML = '<div class="empty-hint">No image, video, or audio attachments found on this dossier.</div>';
                return;
            }
            list.innerHTML = attachmentItems.map((item, i) => `
                <div class="attachment-row">
                    <span class="attachment-index">${i + 1}</span>
                    <span class="attachment-icon">${typeIcon(item.type)}</span>
                    <span class="attachment-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                    <span class="attachment-type">${escapeHtml(item.type)}</span>
                </div>
            `).join('');
        }

        async function loadAttachments() {
            setStatus('info', 'Loading attachments…');
            try {
                const metadata = await article.checkMetadata();
                const articleId = metadata?.MetaData?.BasicMetaData?.ID;
                if (!articleId) throw new Error('Could not read the open article’s ID.');

                const dossierId = await findDossierId(articleId);
                attachmentItems = await fetchAttachments(dossierId);

                renderList();
                clearStatus();

                const sortKeySelect = panelDoc.getElementById('sort-key');
                const btnSort = panelDoc.getElementById('btn-sort');
                sortKeySelect.disabled = attachmentItems.length < 2;
                btnSort.disabled = attachmentItems.length < 2;

                // Best-effort: don't let a date-fetch failure break the
                // panel — name/type sorting already works at this point.
                try {
                    await fetchAttachmentDates(attachmentItems);
                    panelDoc.getElementById('opt-created').disabled = false;
                    panelDoc.getElementById('opt-modified').disabled = false;
                } catch (dateErr) {
                    logWarn('fetchAttachmentDates failed (Date created/modified will stay disabled):', dateErr);
                }
            } catch (err) {
                logError('loadAttachments failed:', err);
                setStatus('error', 'Failed to load attachments: ' + err.message);
                panelDoc.getElementById('attachment-list').innerHTML = '';
            }
        }

        async function onSortClick() {
            const sortKeySelect = panelDoc.getElementById('sort-key');
            const btnSort = panelDoc.getElementById('btn-sort');
            const key = sortKeySelect.value;

            // Live, client-side reorder — instant, no server round-trip needed for the visual update.
            attachmentItems = sortItems(attachmentItems, key);
            lastSortKey = key;
            renderList();
            const label = SORT_LABELS[key] || key;
            setStatus('success', `Sorted by ${label}.`);

            // Persist in the background so the native Attachments panel
            // reflects this order once it next loads/refreshes.
            btnSort.disabled = true;
            try {
                await persistOrder(attachmentItems);
                setStatus('success', `Sorted by ${label} — saved.`);
            } catch (err) {
                logError('persistOrder failed:', err);
                setStatus('error', 'Sorted here, but saving the new order to the server failed: ' + err.message);
            } finally {
                btnSort.disabled = attachmentItems.length < 2;
            }
        }

        const panel = article.addSidebarPanel({
            onInit: async (p) => {
                log('Panel onInit');
                panelDoc = p.window.document;
                panelDoc.open();
                panelDoc.write(buildPanelHTML());
                panelDoc.close();

                panelDoc.getElementById('btn-sort').addEventListener('click', onSortClick);

                await loadAttachments();
            },
            onDestroy: () => {
                log('Panel onDestroy');
                panelDoc = null;
            },
            button: {
                tooltip: CONFIG.panelTooltip,
                icon: {
                    normal: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7f8080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h12M3 18h6"/><path d="M17 18l3-3-3-3"/></svg>'),
                    activated: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h12M3 18h6"/><path d="M17 18l3-3-3-3"/></svg>'),
                },
            },
        });

        void panel;
    });

    console.log('[sort-attachments] Digital Editor sidebar panel plugin loaded.');
})();
//# sourceURL=sort-attachments-panel.js
