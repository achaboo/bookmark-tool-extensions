(() => {
  "use strict";

  // =========================================================================
  //  State
  // =========================================================================
  const state = {
    root: null,           // chrome.bookmarks のルートツリー
    flatNodes: new Map(), // id → BookmarkTreeNode（フラット索引）
    expanded: new Set(),
    selectedId: null,
    visibleRows: [],
    drag: null,
    dropHint: null,
    longPressTimer: null,
    contextTargetId: null,
    searchQuery: "",
    searchMatches: new Set(),
  };

  const supportsPointer = "PointerEvent" in window;

  // =========================================================================
  //  DOM refs
  // =========================================================================
  const els = {
    reloadBtn:    document.getElementById("reloadBtn"),
    addUrlBtn:    document.getElementById("addUrlBtn"),
    addFolderBtn: document.getElementById("addFolderBtn"),
    searchToggle: document.getElementById("searchToggle"),
    searchBar:    document.getElementById("searchBar"),
    searchInput:  document.getElementById("searchInput"),
    searchCount:  document.getElementById("searchCount"),
    searchClear:  document.getElementById("searchClear"),
    status:       document.getElementById("status"),
    infoBar:      document.getElementById("infoBar"),
    treeWrap:     document.getElementById("treeWrap"),
    treeSpacer:   document.getElementById("treeSpacer"),
    ctx:          document.getElementById("ctx"),
    // detail panel
    detailEmpty:      document.getElementById("detailEmpty"),
    detailContent:    document.getElementById("detailContent"),
    detailFavicon:    document.getElementById("detailFavicon"),
    detailTitle:      document.getElementById("detailTitle"),
    detailType:       document.getElementById("detailType"),
    detailName:       document.getElementById("detailName"),
    detailNameSave:   document.getElementById("detailNameSave"),
    detailUrl:        document.getElementById("detailUrl"),
    detailUrlSave:    document.getElementById("detailUrlSave"),
    detailUrlSection: document.getElementById("detailUrlSection"),
    detailOpen:       document.getElementById("detailOpen"),
    detailId:         document.getElementById("detailId"),
    detailDate:       document.getElementById("detailDate"),
    detailChildCount: document.getElementById("detailChildCount"),
    detailPath:       document.getElementById("detailPath"),
    detailDelete:     document.getElementById("detailDelete"),
  };

  // =========================================================================
  //  Helpers
  // =========================================================================
  function setStatus(msg) { els.status.textContent = msg; }

  function faviconUrl(pageUrl) {
    // chrome-extension:// 環境では chrome://favicon は使えないため
    // _favicon API を使う (manifest で "favicon" 権限を宣言済み)
    try {
      const u = new URL(pageUrl);
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(u.href)}&size=16`;
    } catch {
      return "";
    }
  }

  function fallbackFaviconSvg() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' rx='2' fill='%23cbd5e1'/%3E%3Cpath d='M4 5h8v2H4zm0 4h6v2H4z' fill='%23475569'/%3E%3C/svg%3E";
  }

  // =========================================================================
  //  Load bookmarks from Chrome
  // =========================================================================
  async function loadBookmarks() {
    const tree = await chrome.bookmarks.getTree();
    state.root = tree[0]; // ルートノード
    rebuildIndex();
    // ルートの子（ブックマークバー、その他のブックマークなど）を展開
    state.expanded.add(state.root.id);
    if (state.root.children) {
      for (const child of state.root.children) {
        state.expanded.add(child.id);
      }
    }
    renderTree();
    const total = state.flatNodes.size;
    setStatus(`読み込み完了: ${total} 件`);
  }

  function rebuildIndex() {
    state.flatNodes.clear();
    const walk = (node) => {
      state.flatNodes.set(node.id, node);
      if (node.children) {
        for (const child of node.children) walk(child);
      }
    };
    if (state.root) walk(state.root);
  }

  // =========================================================================
  //  Flatten visible rows (virtual scroll)
  // =========================================================================
  function flattenVisible() {
    const list = [];
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")) || 34;

    const walk = (node, depth) => {
      // ルートノードと「ルート直下の仮想フォルダ」(id="0") はスキップせず表示
      // ただし最上位ルート（id="0"）自体はスキップ
      if (node.id !== state.root.id) {
        const isFolder = !node.url;
        const isMatch = state.searchMatches.has(node.id);
        // 検索中は一致しないものをスキップ（ただしフォルダは子に一致があれば表示）
        if (state.searchQuery && !isMatch && !hasMatchingDescendant(node)) {
          return;
        }
        list.push({
          id: node.id,
          node,
          depth,
          isFolder,
          expanded: state.expanded.has(node.id),
          isMatch,
        });
      }
      if (node.children && state.expanded.has(node.id)) {
        for (const child of node.children) {
          walk(child, depth + (node.id === state.root.id ? 0 : 1));
        }
      }
    };

    if (state.root) walk(state.root, 0);
    state.visibleRows = list;
    els.treeSpacer.style.height = list.length * rowH + "px";
  }

  function hasMatchingDescendant(node) {
    if (!node.children) return false;
    for (const child of node.children) {
      if (state.searchMatches.has(child.id)) return true;
      if (hasMatchingDescendant(child)) return true;
    }
    return false;
  }

  function renderTree() {
    flattenVisible();
    renderVisibleWindow();
  }

  function renderVisibleWindow() {
    const list = state.visibleRows;
    const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")) || 34;
    const viewportH = els.treeWrap.clientHeight || 400;
    const scrollTop = els.treeWrap.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / rowH) - 8);
    const end = Math.min(list.length, Math.ceil((scrollTop + viewportH) / rowH) + 8);
    const frag = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
      frag.appendChild(createRow(list[i], i, rowH));
    }

    els.treeSpacer.innerHTML = "";
    els.treeSpacer.appendChild(frag);
  }

  // =========================================================================
  //  Create a single tree row
  // =========================================================================
  function createRow(row, i, rowH) {
    const el = document.createElement("div");
    el.className = "row";
    if (row.isMatch && state.searchQuery) el.classList.add("search-match");
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(row.depth + 1));
    el.setAttribute("aria-selected", String(state.selectedId === row.id));
    el.tabIndex = 0;
    el.style.top = i * rowH + "px";
    el.style.paddingLeft = 8 + row.depth * 18 + "px";
    el.dataset.id = row.id;

    if (state.dropHint && state.dropHint.targetId === row.id) {
      el.classList.add("drop-" + state.dropHint.mode);
    }

    // Expander (folder) or spacer (bookmark)
    if (row.isFolder) {
      const exp = document.createElement("button");
      exp.type = "button";
      exp.className = "expander";
      exp.setAttribute("aria-label", row.expanded ? "フォルダを閉じる" : "フォルダを開く");
      exp.textContent = row.expanded ? "▾" : "▸";
      exp.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFolder(row.id);
      });
      el.appendChild(exp);
    } else {
      const spacer = document.createElement("span");
      spacer.style.width = "22px";
      spacer.style.display = "inline-block";
      el.appendChild(spacer);
    }

    // Favicon
    const icon = document.createElement("img");
    icon.className = "fav";
    icon.alt = "";
    if (row.isFolder) {
      icon.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' rx='2' fill='%23fbbf24'/%3E%3Cpath d='M2 5h12v8H2z' fill='%23f59e0b'/%3E%3Cpath d='M2 4h5l2 2h5v1H2z' fill='%23fbbf24'/%3E%3C/svg%3E";
    } else {
      const src = faviconUrl(row.node.url || "");
      icon.src = src || fallbackFaviconSvg();
      icon.onerror = () => { icon.onerror = null; icon.src = fallbackFaviconSvg(); };
    }
    el.appendChild(icon);

    // Name
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.node.title || row.node.url || "(無題)";
    el.appendChild(name);

    // Badge for folders (child count)
    if (row.isFolder && row.node.children) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `(${row.node.children.length})`;
      el.appendChild(badge);
    }

    // Click
    el.addEventListener("click", () => handleRowClick(row.id));

    // Context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(row.id, e.clientX, e.clientY);
    });

    // Long press
    attachLongPress(el, row.id);

    // Drag and drop
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      state.drag = { sourceId: row.id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.id);
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      updateDropHint(e, row, el);
    });
    el.addEventListener("dragleave", () => {
      state.dropHint = null;
      renderVisibleWindow();
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      performDrop(row.id, e, el);
    });

    return el;
  }

  // =========================================================================
  //  Interactions
  // =========================================================================
  function toggleFolder(id) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderTree();
  }

  function handleRowClick(id) {
    const node = state.flatNodes.get(id);
    if (!node) return;
    state.selectedId = id;
    if (!node.url) {
      // folder: toggle + show detail
      toggleFolder(id);
    }
    showDetail(id);
    renderVisibleWindow();
  }

  // =========================================================================
  //  Detail panel
  // =========================================================================
  function showDetail(id) {
    const node = state.flatNodes.get(id);
    if (!node) return;

    els.detailEmpty.classList.add("hidden");
    els.detailContent.classList.remove("hidden");

    const isFolder = !node.url;

    // Header
    if (isFolder) {
      els.detailFavicon.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='4' fill='%23fbbf24'/%3E%3Cpath d='M4 10h24v16H4z' fill='%23f59e0b'/%3E%3Cpath d='M4 8h10l4 4h10v2H4z' fill='%23fbbf24'/%3E%3C/svg%3E";
    } else {
      const src = faviconUrl(node.url || "");
      els.detailFavicon.src = src || fallbackFaviconSvg();
      els.detailFavicon.onerror = () => { els.detailFavicon.src = fallbackFaviconSvg(); };
    }

    els.detailTitle.textContent = node.title || "(無題)";
    els.detailType.textContent = isFolder ? "📁 フォルダ" : "🔗 ブックマーク";

    // Fields
    els.detailName.value = node.title || "";
    if (isFolder) {
      els.detailUrlSection.classList.add("hidden");
    } else {
      els.detailUrlSection.classList.remove("hidden");
      els.detailUrl.value = node.url || "";
    }

    // Meta
    els.detailId.textContent = `ID: ${node.id}`;
    if (node.dateAdded) {
      els.detailDate.textContent = `作成日: ${new Date(node.dateAdded).toLocaleString("ja-JP")}`;
    } else {
      els.detailDate.textContent = "";
    }

    if (isFolder && node.children) {
      els.detailChildCount.textContent = `子要素: ${node.children.length} 件`;
    } else {
      els.detailChildCount.textContent = "";
    }

    // パスを構築
    els.detailPath.textContent = `場所: ${buildPath(node.id)}`;

    // 特殊フォルダ（ブックマークバーなど）は削除不可
    const isSpecial = node.parentId === "0";
    els.detailDelete.disabled = isSpecial;
    els.detailDelete.title = isSpecial ? "このフォルダは削除できません" : "";
  }

  function buildPath(id) {
    const parts = [];
    let current = state.flatNodes.get(id);
    while (current && current.parentId) {
      const parent = state.flatNodes.get(current.parentId);
      if (parent && parent.title) parts.unshift(parent.title);
      current = parent;
    }
    return parts.join(" / ") || "ルート";
  }

  function hideDetail() {
    els.detailEmpty.classList.remove("hidden");
    els.detailContent.classList.add("hidden");
  }

  // =========================================================================
  //  Chrome bookmarks API wrappers
  // =========================================================================
  async function chromeUpdate(id, changes) {
    try {
      await chrome.bookmarks.update(id, changes);
      await loadBookmarks();
      // 選択中のアイテムの詳細を更新
      if (state.selectedId) showDetail(state.selectedId);
      return true;
    } catch (err) {
      console.error("Update failed:", err);
      setStatus("更新に失敗しました: " + err.message);
      return false;
    }
  }

  async function chromeMove(id, destination) {
    try {
      await chrome.bookmarks.move(id, destination);
      await loadBookmarks();
      return true;
    } catch (err) {
      console.error("Move failed:", err);
      setStatus("移動に失敗しました: " + err.message);
      return false;
    }
  }

  async function chromeCreate(bookmark) {
    try {
      const created = await chrome.bookmarks.create(bookmark);
      await loadBookmarks();
      state.selectedId = created.id;
      showDetail(created.id);
      return created;
    } catch (err) {
      console.error("Create failed:", err);
      setStatus("作成に失敗しました: " + err.message);
      return null;
    }
  }

  async function chromeRemove(id) {
    const node = state.flatNodes.get(id);
    if (!node) return false;
    try {
      if (node.children) {
        await chrome.bookmarks.removeTree(id);
      } else {
        await chrome.bookmarks.remove(id);
      }
      if (state.selectedId === id) {
        state.selectedId = null;
        hideDetail();
      }
      await loadBookmarks();
      return true;
    } catch (err) {
      console.error("Remove failed:", err);
      setStatus("削除に失敗しました: " + err.message);
      return false;
    }
  }

  // =========================================================================
  //  Context menu
  // =========================================================================
  function showContextMenu(id, x, y) {
    state.contextTargetId = id;
    const node = state.flatNodes.get(id);
    if (!node) return;
    const isFolder = !node.url;
    const isSpecial = node.parentId === "0"; // ブックマークバー等

    els.ctx.innerHTML = "";

    const actions = [];

    if (isFolder) {
      actions.push({ label: "📄 新規URL追加", fn: () => promptCreateUrl(id) });
      actions.push({ label: "📁 新規フォルダ追加", fn: () => promptCreateFolder(id) });
      actions.push({ sep: true });
    }

    actions.push({ label: "✏️ 名前変更", fn: () => promptRename(id) });

    if (!isFolder) {
      actions.push({ label: "🔗 新規タブで開く", fn: () => { if (node.url) chrome.tabs.create({ url: node.url }); } });
      actions.push({ label: "📋 URLコピー", fn: () => { if (node.url) navigator.clipboard.writeText(node.url); setStatus("URLをコピーしました"); } });
    }

    actions.push({ sep: true });
    actions.push({ label: "⬆ 上へ移動", fn: () => moveUp(id) });
    actions.push({ label: "⬇ 下へ移動", fn: () => moveDown(id) });

    if (!isSpecial) {
      actions.push({ sep: true });
      actions.push({ label: "🗑 削除", fn: () => promptDelete(id), danger: true });
    }

    for (const a of actions) {
      if (a.sep) {
        els.ctx.appendChild(document.createElement("hr"));
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      if (a.danger) b.style.color = "var(--danger)";
      b.addEventListener("click", () => {
        hideContextMenu();
        a.fn();
      });
      els.ctx.appendChild(b);
    }

    els.ctx.style.left = Math.min(x, window.innerWidth - 200) + "px";
    els.ctx.style.top = Math.min(y, window.innerHeight - 300) + "px";
    els.ctx.classList.add("show");
  }

  function hideContextMenu() {
    els.ctx.classList.remove("show");
    state.contextTargetId = null;
  }

  // =========================================================================
  //  CRUD operations (with prompts)
  // =========================================================================
  async function promptRename(id) {
    const node = state.flatNodes.get(id);
    if (!node) return;
    const next = window.prompt("新しい名前", node.title || "");
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    if (await chromeUpdate(id, { title: trimmed })) {
      setStatus("名前を変更しました");
    }
  }

  async function promptDelete(id) {
    const node = state.flatNodes.get(id);
    if (!node) return;
    const label = node.title || node.url || "(無題)";
    const extra = node.children ? `\n（フォルダ内の ${node.children.length} 件もすべて削除されます）` : "";
    if (!window.confirm(`削除しますか: ${label}${extra}`)) return;
    if (await chromeRemove(id)) {
      setStatus("削除しました");
    }
  }

  async function promptCreateUrl(parentId) {
    const raw = window.prompt("URLを入力", "https://");
    if (!raw) return;
    let url;
    try { url = new URL(raw.trim()).href; } catch {
      try { url = new URL("https://" + raw.trim()).href; } catch {
        setStatus("URLが不正です"); return;
      }
    }
    const title = window.prompt("タイトル", url) || url;
    const created = await chromeCreate({ parentId, title, url });
    if (created) {
      state.expanded.add(parentId);
      setStatus("URLを追加しました");
    }
  }

  async function promptCreateFolder(parentId) {
    const name = window.prompt("フォルダ名", "新規フォルダ");
    if (!name) return;
    const created = await chromeCreate({ parentId, title: name.trim() });
    if (created) {
      state.expanded.add(parentId);
      setStatus("フォルダを追加しました");
    }
  }

  // =========================================================================
  //  Move up / down
  // =========================================================================
  async function moveUp(id) {
    const node = state.flatNodes.get(id);
    if (!node || node.index == null || node.index <= 0) return;
    if (await chromeMove(id, { parentId: node.parentId, index: node.index - 1 })) {
      setStatus("上へ移動しました");
    }
  }

  async function moveDown(id) {
    const node = state.flatNodes.get(id);
    if (!node || node.index == null) return;
    const parent = state.flatNodes.get(node.parentId);
    if (!parent || !parent.children) return;
    if (node.index >= parent.children.length - 1) return;
    if (await chromeMove(id, { parentId: node.parentId, index: node.index + 1 })) {
      setStatus("下へ移動しました");
    }
  }

  // =========================================================================
  //  Drag and drop
  // =========================================================================
  function updateDropHint(e, row, rowEl) {
    const rect = rowEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let mode = "after";
    if (y < rect.height * 0.25) mode = "before";
    else if (y > rect.height * 0.75) mode = "after";
    else if (row.isFolder) mode = "inside";
    state.dropHint = { targetId: row.id, mode };
    renderVisibleWindow();
  }

  async function performDrop(targetId, e, rowEl) {
    const sourceId = state.drag ? state.drag.sourceId : e.dataTransfer.getData("text/plain");
    state.drag = null;
    state.dropHint = null;
    if (!sourceId || sourceId === targetId) { renderVisibleWindow(); return; }

    const sourceNode = state.flatNodes.get(sourceId);
    const targetNode = state.flatNodes.get(targetId);
    if (!sourceNode || !targetNode) { renderVisibleWindow(); return; }

    const rect = rowEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    let mode = "after";
    if (y < rect.height * 0.25) mode = "before";
    else if (y > rect.height * 0.75) mode = "after";
    else if (!targetNode.url) mode = "inside";

    // 自分自身の配下への移動を防止
    if (!sourceNode.url && mode === "inside") {
      if (isDescendant(sourceId, targetId)) {
        setStatus("フォルダ配下へ自分自身は移動できません");
        renderVisibleWindow();
        return;
      }
    }

    let destination;
    if (mode === "inside" && !targetNode.url) {
      // フォルダの中の先頭に入れる
      destination = { parentId: targetId, index: 0 };
      state.expanded.add(targetId);
    } else if (mode === "before") {
      destination = { parentId: targetNode.parentId, index: targetNode.index };
    } else {
      // after
      destination = { parentId: targetNode.parentId, index: targetNode.index + 1 };
    }

    // 同じ親内で後方に移動する場合、削除後にインデックスがずれるので補正
    if (sourceNode.parentId === destination.parentId && sourceNode.index < destination.index) {
      destination.index -= 1;
    }

    if (await chromeMove(sourceId, destination)) {
      setStatus("並び替えを更新しました");
    } else {
      renderVisibleWindow();
    }
  }

  function isDescendant(ancestorId, checkId) {
    const root = state.flatNodes.get(ancestorId);
    if (!root || !root.children) return false;
    const stack = [...root.children];
    while (stack.length) {
      const n = stack.pop();
      if (n.id === checkId) return true;
      if (n.children) stack.push(...n.children);
    }
    return false;
  }

  // =========================================================================
  //  Long press (mobile-friendly)
  // =========================================================================
  function attachLongPress(el, id) {
    const start = (ev) => {
      if (ev.type === "mousedown" && ev.button !== 0) return;
      clearTimeout(state.longPressTimer);
      state.longPressTimer = setTimeout(() => {
        const p = pointFromEvent(ev);
        showContextMenu(id, p.x, p.y);
      }, 480);
    };
    const cancel = () => clearTimeout(state.longPressTimer);

    if (supportsPointer) {
      el.addEventListener("pointerdown", start);
      el.addEventListener("pointerup", cancel);
      el.addEventListener("pointercancel", cancel);
      el.addEventListener("pointermove", cancel);
    } else {
      el.addEventListener("touchstart", start, { passive: true });
      el.addEventListener("touchend", cancel);
      el.addEventListener("touchcancel", cancel);
      el.addEventListener("mousedown", start);
      el.addEventListener("mouseup", cancel);
      el.addEventListener("mouseleave", cancel);
    }
  }

  function pointFromEvent(ev) {
    if (ev.touches && ev.touches[0]) return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
    return { x: ev.clientX || 10, y: ev.clientY || 10 };
  }

  // =========================================================================
  //  Search
  // =========================================================================
  function performSearch(query) {
    state.searchQuery = query;
    state.searchMatches.clear();

    if (!query) {
      els.searchCount.textContent = "";
      renderTree();
      return;
    }

    const lower = query.toLowerCase();
    for (const [id, node] of state.flatNodes) {
      const title = (node.title || "").toLowerCase();
      const url = (node.url || "").toLowerCase();
      if (title.includes(lower) || url.includes(lower)) {
        state.searchMatches.add(id);
        // 親フォルダも展開する
        let parentId = node.parentId;
        while (parentId) {
          state.expanded.add(parentId);
          const parent = state.flatNodes.get(parentId);
          parentId = parent ? parent.parentId : null;
        }
      }
    }

    els.searchCount.textContent = `${state.searchMatches.size} 件`;
    renderTree();
  }

  // =========================================================================
  //  Event bindings
  // =========================================================================
  function bindEvents() {
    // Top bar buttons
    els.reloadBtn.addEventListener("click", async () => {
      await loadBookmarks();
      setStatus("再読み込みしました");
    });

    els.addUrlBtn.addEventListener("click", () => {
      // 選択中のフォルダ、またはルートの最初のフォルダ（ブックマークバー）に追加
      const parentId = getTargetFolderId();
      promptCreateUrl(parentId);
    });

    els.addFolderBtn.addEventListener("click", () => {
      const parentId = getTargetFolderId();
      promptCreateFolder(parentId);
    });

    // Search
    els.searchToggle.addEventListener("click", () => {
      const isHidden = els.searchBar.classList.contains("hidden");
      els.searchBar.classList.toggle("hidden");
      if (isHidden) {
        els.searchInput.focus();
      } else {
        els.searchInput.value = "";
        performSearch("");
      }
    });

    let searchTimer;
    els.searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => performSearch(els.searchInput.value.trim()), 200);
    });

    els.searchClear.addEventListener("click", () => {
      els.searchInput.value = "";
      performSearch("");
      els.searchBar.classList.add("hidden");
    });

    // Detail panel buttons
    els.detailNameSave.addEventListener("click", async () => {
      if (!state.selectedId) return;
      const newTitle = els.detailName.value.trim();
      if (!newTitle) return;
      if (await chromeUpdate(state.selectedId, { title: newTitle })) {
        setStatus("名前を保存しました");
      }
    });

    els.detailUrlSave.addEventListener("click", async () => {
      if (!state.selectedId) return;
      const newUrl = els.detailUrl.value.trim();
      if (!newUrl) return;
      if (await chromeUpdate(state.selectedId, { url: newUrl })) {
        setStatus("URLを保存しました");
      }
    });

    els.detailOpen.addEventListener("click", () => {
      const node = state.flatNodes.get(state.selectedId);
      if (node && node.url) chrome.tabs.create({ url: node.url });
    });

    els.detailDelete.addEventListener("click", () => {
      if (state.selectedId) promptDelete(state.selectedId);
    });

    // Context menu close
    document.addEventListener("click", (e) => {
      if (!els.ctx.contains(e.target)) hideContextMenu();
    });
    window.addEventListener("scroll", hideContextMenu, true);
    window.addEventListener("resize", hideContextMenu);

    // Tree scroll (virtual scroll)
    els.treeWrap.addEventListener("scroll", renderVisibleWindow, { passive: true });

    // Keyboard shortcut
    document.addEventListener("keydown", (e) => {
      if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
        e.preventDefault();
        loadBookmarks();
      }
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        els.searchBar.classList.remove("hidden");
        els.searchInput.focus();
      }
      if (e.key === "Escape") {
        hideContextMenu();
        if (!els.searchBar.classList.contains("hidden")) {
          els.searchInput.value = "";
          performSearch("");
          els.searchBar.classList.add("hidden");
        }
      }
      if (e.key === "Delete" && state.selectedId) {
        const node = state.flatNodes.get(state.selectedId);
        if (node && node.parentId !== "0") promptDelete(state.selectedId);
      }
    });

    // Listen for external bookmark changes
    chrome.bookmarks.onCreated.addListener(() => loadBookmarks());
    chrome.bookmarks.onRemoved.addListener(() => loadBookmarks());
    chrome.bookmarks.onChanged.addListener(() => loadBookmarks());
    chrome.bookmarks.onMoved.addListener(() => loadBookmarks());
  }

  function getTargetFolderId() {
    if (state.selectedId) {
      const node = state.flatNodes.get(state.selectedId);
      if (node) {
        // 選択がフォルダならそこに追加
        if (!node.url) return node.id;
        // 選択がブックマークなら親フォルダに追加
        return node.parentId;
      }
    }
    // デフォルト: ブックマークバー(id=1) or ルートの最初の子
    if (state.root && state.root.children && state.root.children.length > 0) {
      return state.root.children[0].id;
    }
    return "1";
  }

  // =========================================================================
  //  Bootstrap
  // =========================================================================
  async function bootstrap() {
    bindEvents();
    await loadBookmarks();
  }

  bootstrap();
})();
