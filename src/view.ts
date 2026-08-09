import { ItemView, WorkspaceLeaf, Modal } from "obsidian";
import type MeowbiusPlugin from "./main";
import { MNode, VaultModel, scopeStats, collectCharacters } from "./model";
import {
  STATUSES,
  STANDARD,
  TPL_FILE,
  TPL_TYPES,
  normalizeName,
} from "./constants";

export const VIEW_TYPE = "meowbius-kanban-view";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Times {
  created?: number;
  mtime?: number;
}

function spaceTimes(node: MNode): Times {
  let created: number | undefined;
  let mtime: number | undefined;
  const walk = (n: MNode) => {
    if (n.type === "note") {
      if (n.created !== undefined)
        created =
          created === undefined ? n.created : Math.min(created, n.created);
      if (n.mtime !== undefined)
        mtime = mtime === undefined ? n.mtime : Math.max(mtime, n.mtime);
    } else {
      for (const c of n.children || []) walk(c);
    }
  };
  walk(node);
  return { created, mtime };
}

/* ====================== 看板视图 ====================== */
export class KanbanView extends ItemView {
  plugin: MeowbiusPlugin;
  kanbanTab: string = "overview";

  constructor(leaf: WorkspaceLeaf, plugin: MeowbiusPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Meowbius_S.S";
  }
  getIcon(): string {
    return "layout-grid";
  }

  /** 取得本插件 icons/ 目录下资源的可用 URL（跟随插件部署，不依赖外部路径） */
  private iconUrl(name: string): string {
    const id = this.plugin.manifest.id;
    const rel = `${this.app.vault.configDir}/plugins/${id}/icons/${name}`;
    return this.app.vault.adapter.getResourcePath(rel);
  }

  async onOpen(): Promise<void> {
    await this.render();
  }
  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  async render(): Promise<void> {
    const model = this.plugin.model || (await this.plugin.refreshModel());
    const root = this.contentEl;
    root.empty();
    root.addClass("mb-view");
    const kanban = root.createDiv({ cls: "mb-kanban" });
    kanban.innerHTML = this.kanbanHTML(model);
    this.wire(kanban);
  }

  /* ---------- 页签与排序 ---------- */
  private defaultOrder(model: VaultModel): string[] {
    const spaces = model.spaces.map((s) => s.name);
    return ["overview", ...spaces, "灵感收集", "模板库"];
  }

  private syncOrder(model: VaultModel): void {
    const expected = this.defaultOrder(model);
    const order = this.plugin.settings.kanbanOrder;
    const kept = order.filter((id) => expected.includes(id));
    const missing = expected.filter((id) => !kept.includes(id));
    const idx = kept.lastIndexOf("灵感收集");
    let next: string[];
    if (idx >= 0) {
      next = [...kept];
      next.splice(idx + 1, 0, ...missing);
    } else {
      next = [...kept, ...missing];
    }
    if (next.join("|") !== order.join("|")) {
      this.plugin.settings.kanbanOrder = next;
      void this.plugin.saveSettings();
    }
  }

  private tabLabel(id: string): string {
    if (id === "overview") return "📊 总体";
    if (id === "灵感收集") return "📥 灵感收集";
    if (id === "模板库") return "📚 模板库";
    return "✨ " + id;
  }

  private kt(id: string, label: string): string {
    return `<div class="ktab ${
      this.kanbanTab === id ? "active" : ""
    }" data-k="${esc(id)}">${label}</div>`;
  }

  /* ---------- 总装 ---------- */
  private kanbanHTML(model: VaultModel): string {
    this.syncOrder(model);
    const visible = this.plugin.settings.kanbanOrder.filter(
      (id) => !this.plugin.settings.kanbanHidden[id]
    );
    let t = `<div class="ktabs">`;
    visible.forEach((id) => {
      t += this.kt(id, this.tabLabel(id));
    });
    const icSet = this.iconUrl("setting.svg");
    const icSync = this.iconUrl("sync.svg");
    t += `<div class="ktab" data-global-refresh title="刷新全部数据"><span class="mb-icon" style="--mb-mask:url('${icSync}')"></span></div>`;
    t += `<div class="ktab ${
      this.kanbanTab === "config" ? "active" : ""
    }" data-k="config" title="看板配置（顺序 / 显隐）"><span class="mb-icon" style="--mb-mask:url('${icSet}')"></span></div>`;
    t += `</div>`;

    if (this.kanbanTab === "overview") t += this.overviewHTML(model);
    else if (this.kanbanTab === "灵感收集") t += this.inspirationHTML(model);
    else if (this.kanbanTab === "模板库") t += this.templateBoardHTML(model);
    else if (this.kanbanTab === "config") t += this.configHTML(model);
    else t += this.entityHTML(model, this.kanbanTab);
    return t;
  }

  /* ---------- 总览 ---------- */
  private overviewHTML(model: VaultModel): string {
    const scope = this.plugin.settings.statScope;
    const spaces = model.spaces;
    const totalPits = spaces.length;
    const stCount: Record<string, number> = {};
    STATUSES.forEach((s) => (stCount[s] = 0));
    spaces.forEach((s) => {
      const st = this.plugin.settings.spaceStatus[s.name] || "前期准备";
      stCount[st] = (stCount[st] || 0) + 1;
    });
    const rows = spaces.map((s) => {
      const st = scopeStats(s, scope);
      return { name: s.name, w: st.w, n: st.n, y: st.y };
    });
    const totalWords = rows.reduce((a, r) => a + r.w, 0);
    const totalYear = rows.reduce((a, r) => a + r.y, 0);
    const totalNotes = rows.reduce((a, r) => a + r.n, 0);
    const chars = collectCharacters(model, scope);

    let h = `<div class="ksec"><h3 class="board-title">📊 总体统计</h3><div class="stat-grid">
      <div class="stat-card"><div class="big">${totalPits}</div><div class="lbl">总坑数（脑洞空间）</div></div>
      <div class="stat-card"><div class="big">${totalWords}</div><div class="lbl">总字数</div><div class="sub">今年更新 ${totalYear}</div></div>
    </div></div>`;

    h += `<div class="ksec"><h3>🕳️ 各状态坑个数</h3><div class="chips">`;
    STATUSES.forEach((s) => (h += `<div class="chip"><b>${stCount[s]}</b>${s}</div>`));
    h += `</div></div>`;

    h += `<div class="ksec"><h3>📝 总字数及各坑占比</h3>`;
    if (!rows.length) h += `<p class="muted">暂无脑洞空间。</p>`;
    else {
      h += `<div class="scope-grid">`;
      rows.forEach((r) => {
        const wp = totalWords ? Math.round((r.w / totalWords) * 100) : 0;
        const np = totalNotes ? Math.round((r.n / totalNotes) * 100) : 0;
        h += `<div class="scope-card"><div class="scope-card-name">${esc(r.name)}</div><div class="scope-card-big">${r.w}<span class="scope-card-unit">字</span></div><div class="scope-card-meta">占比 ${wp}% · ${r.n} 个文件 · 占比 ${np}%</div><div class="bar"><div class="bar-fill" style="width:${wp}%"></div></div></div>`;
      });
      h += `</div>`;
    }
    h += `</div>`;

    h += `<div class="ksec"><h3>📅 今年更新字数及各坑占比</h3>`;
    if (!rows.length) h += `<p class="muted">暂无脑洞空间。</p>`;
    else {
      h += `<div class="scope-grid">`;
      rows.forEach((r) => {
        const yp = totalYear ? Math.round((r.y / totalYear) * 100) : 0;
        const np = totalNotes ? Math.round((r.n / totalNotes) * 100) : 0;
        h += `<div class="scope-card"><div class="scope-card-name">${esc(r.name)}</div><div class="scope-card-big">${r.y}<span class="scope-card-unit">字</span></div><div class="scope-card-meta">占比 ${yp}% · ${r.n} 个文件 · 占比 ${np}%</div><div class="bar"><div class="bar-fill" style="width:${yp}%"></div></div></div>`;
      });
      h += `</div>`;
    }
    h += `</div>`;

    h += `<div class="ksec"><h3>👥 角色词云（取自各脑洞「${normalizeName(
      STANDARD[2]
    )}」文件夹）</h3>`;
    if (!chars.length) {
      h += `<p class="muted">当前统计范围未包含「${normalizeName(
        STANDARD[2]
      )}」，暂无可展示的角色词云。</p></div>`;
    } else {
      h += `<div class="cloud">`;
      chars.forEach((ch) => {
        const size = 15 + Math.min(22, Math.floor(ch.w / 12));
        h += `<span style="font-size:${size}px">${esc(ch.name)}</span>`;
      });
      h += `</div></div>`;
    }
    return h;
  }

  /* ---------- 单脑洞：三个堆叠模块 ---------- */
  private entityHTML(model: VaultModel, name: string): string {
    const node = model.spaces.find((s) => s.name === name);
    if (!node)
      return `<p class="muted">未找到脑洞空间「${esc(name)}」。</p>`;

    let h = "";
    // 模块 1：基本信息
    h += this.entityBasicInfo(node);
    // 模块 2：速览
    h += this.entityOverview(node);
    // 模块 3：热力图
    h += this.heatmapSection(node.path + "/", "🔥 活跃热力图（近 12 个月）");
    return h;
  }

  /** 模块 1：基本信息（创建时间 / 最近更新 / 总字数 / 总文件数） */
  private entityBasicInfo(node: MNode): string {
    const t = spaceTimes(node);
    const created = t.created
      ? new Date(t.created).toLocaleString("zh-CN")
      : "—";
    const mtime = t.mtime ? new Date(t.mtime).toLocaleString("zh-CN") : "—";
    return `<div class="ksec entity-mod">
      <h3 class="mod-title">📋 基本信息</h3>
      <div class="info-grid">
        <div class="info-item"><span class="info-k">🗓️ 创建时间</span><span class="info-v">${created}</span></div>
        <div class="info-item"><span class="info-k">🔄 最近更新</span><span class="info-v">${mtime}</span></div>
        <div class="info-item"><span class="info-k">📝 总字数</span><span class="info-v">${node.words}</span></div>
        <div class="info-item"><span class="info-k">📁 总文件数</span><span class="info-v">${node.notes}</span></div>
      </div>
    </div>`;
  }

  /** 模块 2：速览（各子文件夹文件数 / 总字数 / 新建入口） */
  private entityOverview(node: MNode): string {
    const cards = this.renderSubCards(node, true);
    let h = `<div class="ksec entity-mod"><h3 class="mod-title">⚡ 速览</h3>`;
    h += cards || `<div class="eempty">无子文件夹</div>`;
    h += `</div>`;
    return h;
  }

  /** 子文件夹卡片（速览 / 灵感收集共用）：文件数 + 字数 + 点击新建；showLocate 控制是否显示「定位」按钮 */
  private renderSubCards(node: MNode, showLocate: boolean): string {
    const kids = (node.children || []).filter(
      (c) => c.type === "folder" && !this.plugin.settings.cardHidden[c.path]
    );
    if (!kids.length) return "";
    let h = `<div class="card-grid">`;
    for (const ch of kids) {
      const cp = ch.path;
      h += `<div class="type-card" data-newfile="${esc(cp)}">
        ${showLocate ? `<button class="loc" data-focus="${esc(cp)}" title="在文件栏定位">📂</button>` : ""}
        <div class="tc-name">${esc(ch.name)}</div>
        <div class="tc-meta"><span class="tc-num">${ch.notes}</span> 个文件 · ${
        ch.words
      } 字</div>
        <div class="tc-add">＋ 点击新建笔记</div>
      </div>`;
    }
    h += `</div>`;
    return h;
  }

  /* ---------- 文件夹信息 / 子文件夹卡片配置 ---------- */
  private folderMetaHTML(node: MNode): string {
    const t = spaceTimes(node);
    const created = t.created
      ? new Date(t.created).toLocaleDateString("zh-CN")
      : "—";
    const mtime = t.mtime
      ? new Date(t.mtime).toLocaleDateString("zh-CN")
      : "—";
    let h = `<div class="ksec"><h3>📁 文件夹信息</h3>
      <div class="meta-grid">
        <div class="meta-row"><span class="meta-k">🗓️ 创建时间</span><span class="meta-v">${created}</span></div>
        <div class="meta-row"><span class="meta-k">🔄 最近更新</span><span class="meta-v">${mtime}</span></div>
      </div>
      <h3 style="margin-top:12px">🗂️ 子文件夹卡片</h3>
      <div class="sub-toggle-list">`;
    const kids = (node.children || []).filter((c) => c.type === "folder");
    if (!kids.length) {
      h += `<div class="sub-empty">无子文件夹</div>`;
    } else {
      for (const ch of kids) {
        const hidden = !!this.plugin.settings.cardHidden[ch.path];
        h += `<div class="sub-toggle ${
          hidden ? "off" : ""
        }" data-cardtoggle="${esc(ch.path)}">
          <span class="st-name">${esc(ch.name)}</span>
          <span class="st-state">${hidden ? "已隐藏" : "展示中"}</span>
        </div>`;
      }
    }
    h += `</div></div>`;
    return h;
  }

  /* ---------- 灵感收集 ---------- */
  private inspirationHTML(model: VaultModel): string {
    const root = model.inspRoot;
    if (!root)
      return `<p class="muted">未找到「${esc(model.rootName)}」根目录。</p>`;
    return (
      `<div class="ksec"><h3 class="board-title">📥 灵感收集</h3>` +
      this.folderMetaHTML(root) +
      this.renderSubCards(root, true) +
      `</div>` +
      this.heatmapSection(root.path + "/", "🔥 灵感收集活跃热力图（近 12 个月）")
    );
  }

  /* ---------- 模板库看板 ---------- */
  private templateBoardHTML(model: VaultModel): string {
    const targets: MNode[] = [];
    if (model.inspRoot) targets.push(model.inspRoot);
    targets.push(...model.spaces);

    let h = `<div class="tpl-sec"><div class="ksec"><h3 class="board-title">📚 模板库看板</h3>`;
    if (model.library) h += this.folderMetaHTML(model.library);
    h += `<div class="tpl-grid">
        <div class="tpl-row tpl-head"><div class="tpl-name">目录 ＼ 模板</div>`;
    TPL_TYPES.forEach((t) => (h += `<div class="tpl-colhead">${t.label}</div>`));
    h += `</div>`;

    for (const space of targets) {
      h += `<div class="tpl-row"><div class="tpl-name" title="${esc(
        space.name
      )}">${esc(space.name)}</div>`;
      for (const t of TPL_TYPES) {
        const path = `${space.path}/模板/${TPL_FILE[t.k]}`;
        const node = this.plugin.nodeByPath(path);
        const exists = node && node.type === "note";
        const hasContent = !!exists && (node as MNode).words > 0;
        let cls: string, act: string, tip: string;
        if (!exists) {
          cls = "tpl-off";
          act = `data-needtpl="${esc(path)}"`;
          tip = `${space.name} · ${t.label}模板（缺失，点击新建）`;
        } else if (hasContent) {
          cls = "tpl-on";
          act = `data-tpledit="${esc(path)}"`;
          tip = `${space.name} · ${t.label}模板（点击编辑）`;
        } else {
          cls = "tpl-empty";
          act = `data-tpledit="${esc(path)}"`;
          tip = `${space.name} · ${t.label}模板（存在但为空，点击编辑）`;
        }
        h += `<div class="tpl-cell ${cls}" ${act} title="${esc(tip)}"></div>`;
      }
      h += `</div>`;
    }
    h += `</div>
      <div class="tpl-legend">
        <span><span class="sq" style="background:var(--mb-green)"></span>已存在且有内容</span>
        <span><span class="sq" style="background:var(--mb-orange)"></span>存在但为空</span>
        <span><span class="sq" style="background:#5a3a3e"></span>缺失（点击新建）</span>
      </div>
    </div></div>`;
    return h;
  }

  /* ---------- 配置 ---------- */
  private configHTML(model: VaultModel): string {
    const order = this.plugin.settings.kanbanOrder;
    const hidden = this.plugin.settings.kanbanHidden;
    let h = `<div class="ksec"><h3 class="board-title">⚙️ 看板配置</h3><div class="cfgtab-list">`;
    order.forEach((id, i) => {
      const label = this.tabLabel(id);
      const isHidden = hidden[id];
      h += `<div class="cfgtab ${isHidden ? "off" : ""}" draggable="true" data-drag="${esc(
        id
      )}">
        <span class="ct-name"><span class="ct-handle">☰</span>${esc(
        label
      )}</span>
        <span class="ct-act">
          <button class="mb-btn tiny" data-move="${esc(
            id
          )}" data-dir="up" ${i === 0 ? "disabled" : ""}>↑ 上移</button>
          <button class="mb-btn tiny" data-move="${esc(
            id
          )}" data-dir="down" ${
        i === order.length - 1 ? "disabled" : ""
      }>↓ 下移</button>
          <button class="mb-btn tiny" data-hide="${esc(
            id
          )}">${isHidden ? "显示" : "隐藏"}</button>
        </span>
      </div>`;
    });
    h += `</div>`;
    h += `<div class="ksec"><h3>📊 统计范围</h3><div class="scope-tags">`;
    const excl = this.plugin.settings.statScope;
    this.plugin.allTypeNames().forEach((t) => {
      const active = excl.length === 0 || !excl.includes(t);
      h += `<span class="scope-tag ${
        active ? "active" : ""
      }" data-scope="${esc(t)}">${esc(t)}</span>`;
    });
    h += `</div></div>`;
    h += `<div class="ksec"><h3>🧭 文件夹映射</h3><button class="mb-btn primary" data-adopt>🔄 映射文件夹</button></div>`;
    h += `</div>`;
    return h;
  }

  /* ---------- 热力图（通用，按 prefix 限定子树） ---------- */
  private heatmapSection(prefix: string | undefined, title: string): string {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 363);
    const sd = start.getDay();
    start.setDate(start.getDate() - sd);
    const days: Date[] = [];
    const cur = new Date(start);
    while (cur <= today) {
      days.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    const cols = Math.ceil(days.length / 7);
    const MON = [
      "1月",
      "2月",
      "3月",
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
      "10月",
      "11月",
      "12月",
    ];
    const labels = new Array(cols).fill("");
    const map = this.plugin.heatmapMap(prefix);
    let maxv = 0;
    for (const d of days) {
      const v =
        map.get(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`) || 0;
      if (v > maxv) maxv = v;
    }
    const cells: string[] = [];
    days.forEach((d, i) => {
      const col = Math.floor(i / 7);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const v = map.get(key) || 0;
      const lvl = maxv > 0 ? Math.min(4, Math.ceil((v / maxv) * 4)) : 0;
      if (i % 7 === 0) {
        const m = MON[d.getMonth()];
        if (col === 0) labels[col] = m;
        else if (days[(col - 1) * 7].getMonth() !== d.getMonth())
          labels[col] = m;
      }
      cells.push(
        `<div class="hm-cell lvl${lvl}" title="${key}${
          v ? "：" + v + " 字" : ""
        }"></div>`
      );
    });
    const labelsHTML = labels.map((m) => `<span class="hm-ml">${m}</span>`).join("");
    const hint = map.size === 0 ? `<p class="muted">暂无活动数据。</p>` : "";
    return `<div class="ksec entity-mod"><h3 class="mod-title">${title}</h3>
      ${hint}
      <div class="hm-scroll" id="hmScroll"><div class="hm-inner">
        <div class="hm-labels">${labelsHTML}</div>
        <div class="hm-grid">${cells.join("")}</div>
      </div></div>
      <div class="hm-legend"><span>少</span><span class="hm-cell lvl0"></span><span class="hm-cell lvl1"></span><span class="hm-cell lvl2"></span><span class="hm-cell lvl3"></span><span class="hm-cell lvl4"></span><span>多</span></div>
    </div>`;
  }

  /* ---------- 事件绑定 ---------- */
  private wire(kanban: HTMLElement): void {
    const plugin = this.plugin;
    kanban.querySelectorAll<HTMLElement>(".ktab").forEach((el) => {
      el.onclick = () => {
        this.kanbanTab = el.dataset.k!;
        void this.render();
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-newfile]").forEach((el) => {
      el.onclick = () => {
        void plugin.quickCreate(el.dataset.newfile!);
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-focus]").forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation();
        plugin.revealPath(el.dataset.focus!);
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-cardtoggle]").forEach((el) => {
      el.onclick = () => {
        plugin.toggleCardHidden(el.dataset.cardtoggle!);
        void this.render();
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-tpledit]").forEach((el) => {
      el.onclick = () => plugin.openFilePath(el.dataset.tpledit!);
    });
    kanban.querySelectorAll<HTMLElement>("[data-needtpl]").forEach((el) => {
      el.onclick = () => {
        const path = el.dataset.needtpl!;
        confirmModal(
          plugin,
          `「${path}」模板缺失，是否新建？`,
          () => void plugin.createMissingTemplate(path)
        );
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-move]").forEach((el) => {
      el.onclick = () => {
        plugin.moveTab(el.dataset.move!, el.dataset.dir as "up" | "down");
        void this.render();
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-hide]").forEach((el) => {
      el.onclick = () => {
        plugin.toggleHide(el.dataset.hide!);
        void this.render();
      };
    });
    kanban.querySelectorAll<HTMLElement>("[data-adopt]").forEach((el) => {
      el.onclick = () => plugin.openAdoption();
    });
    // 全局刷新按钮（tab 栏 🔄）
    kanban.querySelectorAll<HTMLElement>("[data-global-refresh]").forEach((el) => {
      el.onclick = () => { void plugin.refreshModel(); void this.render(); };
    });
    kanban.querySelectorAll<HTMLElement>(".scope-tag").forEach((el) => {
      el.onclick = () => {
        plugin.toggleScope(el.dataset.scope!);
        void this.render();
      };
    });

    // 拖拽排序
    let dragId: string | null = null;
    kanban.querySelectorAll<HTMLElement>("[data-drag]").forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        dragId = el.dataset.drag!;
        el.classList.add("dragging");
        try {
          e.dataTransfer!.effectAllowed = "move";
        } catch {
          /* 忽略 */
        }
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
        kanban
          .querySelectorAll("[data-drag]")
          .forEach((x) => x.classList.remove("dragover"));
      });
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        el.classList.add("dragover");
      });
      el.addEventListener("dragleave", () => el.classList.remove("dragover"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("dragover");
        const toId = el.dataset.drag!;
        if (!dragId || dragId === toId) return;
        const order = plugin.settings.kanbanOrder;
        const from = order.indexOf(dragId);
        const to = order.indexOf(toId);
        if (from < 0 || to < 0) return;
        order.splice(from, 1);
        order.splice(to, 0, dragId);
        dragId = null;
        void plugin.saveSettings();
        void this.render();
      });
    });

    this.attachHeatmapDrag(kanban);
  }

  private attachHeatmapDrag(kanban: HTMLElement): void {
    const sc = kanban.querySelector<HTMLElement>("#hmScroll");
    if (!sc) return;
    let down = false,
      sx = 0,
      sl = 0;
    sc.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return;
      down = true;
      sx = e.clientX;
      sl = sc.scrollLeft;
    });
    sc.addEventListener("pointermove", (e) => {
      if (!down) return;
      sc.scrollLeft = sl - (e.clientX - sx);
    });
    const end = () => {
      down = false;
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointerleave", end);
    sc.addEventListener("pointercancel", end);
  }
}

/* ====================== 确认弹窗 ====================== */
class ConfirmModal extends Modal {
  private plugin: MeowbiusPlugin;
  private message: string;
  private onYes: () => void;

  constructor(plugin: MeowbiusPlugin, message: string, onYes: () => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.message = message;
    this.onYes = onYes;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "请确认" });
    contentEl.createEl("p", { text: this.message, cls: "mb-label" });
    const bar = contentEl.createDiv({
      attr: { style: "margin-top:12px;display:flex;gap:10px;justify-content:flex-end;" },
    });
    const cancel = bar.createEl("button", {
      text: "取消",
      cls: "mb-btn ghost",
    });
    cancel.addEventListener("click", () => this.close());
    const yes = bar.createEl("button", {
      text: "确定",
      cls: "mb-btn primary",
    });
    yes.addEventListener("click", () => {
      this.onYes();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function confirmModal(
  plugin: MeowbiusPlugin,
  message: string,
  onYes: () => void
): void {
  new ConfirmModal(plugin, message, onYes).open();
}
