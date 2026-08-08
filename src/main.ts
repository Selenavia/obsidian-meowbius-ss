import {
  Plugin,
  Notice,
  TFile,
  TFolder,
  TAbstractFile,
  Modal,
  Setting,
  PluginSettingTab,
  WorkspaceLeaf,
} from "obsidian";
import { KanbanView, VIEW_TYPE } from "./view";
import { AdoptionModal } from "./adopt";
import { buildModel, VaultModel, MNode, findNode, spaceTypes } from "./model";
import {
  Revisions,
  ensureRecord,
  recordModify,
} from "./revision";
import * as C from "./constants";

interface MeowbiusSettings {
  rootName: string;
  kanbanOrder: string[];
  kanbanHidden: Record<string, boolean>;
  cardHidden: Record<string, boolean>;
  statScope: string[];
  spaceStatus: Record<string, string>;
  spaceDesc: Record<string, string>;
  initialized: boolean;
}

const DEFAULT_SETTINGS: MeowbiusSettings = {
  rootName: "灵感收集",
  kanbanOrder: [],
  kanbanHidden: {},
  cardHidden: {},
  statScope: [...C.STANDARD],
  spaceStatus: {},
  spaceDesc: {},
  initialized: false,
};

function firstLineSummary(content: string, max = 40): string {
  const lines = content
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter((l) => l.length > 0);
  const s = lines[0] || "（空笔记）";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export default class MeowbiusPlugin extends Plugin {
  settings: MeowbiusSettings = Object.assign({}, DEFAULT_SETTINGS);
  revisions: Revisions = {};
  model: VaultModel | null = null;

  private refreshTimer: number | null = null;
  private saveTimer: number | null = null;

  async onload(): Promise<void> {
    try {
      await this.loadSettings();
      this.model = await this.refreshModel();
      await this.bootstrapRevisions();

      // 首次接入向导：结构化检测已有文件夹，让用户逐文件夹决定保留/删除/映射
      if (!this.settings.initialized) {
        this.app.workspace.onLayoutReady(() =>
          new AdoptionModal(this).open()
        );
      }

      // 侧边栏入口
      this.addRibbonIcon("paw-print", "打开 Meowbius_S.S 看板", () => this.openKanban());

      // 看板视图
      this.registerView(VIEW_TYPE, (leaf) => new KanbanView(leaf, this));

      // 命令
      this.addCommand({
        id: "open-kanban",
        name: "打开 Meowbius_S.S",
        callback: () => this.openKanban(),
      });
      this.addCommand({
        id: "new-space",
        name: "新建脑洞空间",
        callback: () => new NewSpaceModal(this).open(),
      });
      this.addCommand({
        id: "capture",
        name: "快速捕捉：只言片语",
        callback: () => new CaptureModal(this).open(),
      });
      this.addCommand({
        id: "random",
        name: "随机灵感",
        callback: () => new RandomModal(this).open(),
      });
      this.addCommand({
        id: "revision",
        name: "查看当前文件修订记录",
        callback: () => this.openRevision(),
      });
      this.addCommand({
        id: "adopt-structure",
        name: "文件夹映射",
        callback: () => new AdoptionModal(this).open(),
      });

      this.addSettingTab(new MeowbiusSettingTab(this));

      // 监听仓库变化：记录修订 + 延迟刷新看板
      this.registerEvent(
        this.app.vault.on("create", (f) => this.onVaultChange(f))
      );
      this.registerEvent(
        this.app.vault.on("modify", (f) => this.onVaultChange(f))
      );
      this.registerEvent(
        this.app.vault.on("delete", (f) => this.onVaultDelete(f))
      );
    } catch (e) {
      console.error("[Meowbius_S.S] onload error:", e);
      new Notice(`Meowbius_S.S 加载失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async onunload(): Promise<void> {
    await this.saveRevisionsNow();
  }

  /* ---------------- 数据持久化 ---------------- */
  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (data && data.settings) || {});
    this.revisions = (data && data.revisions) || {};
    // 规范化统计范围（statScope 现为「排除列表」）：
    // 旧版 opt-in 默认 == 全套 STANDARD，在新语义下即「计入全部类型」→ 置空。
    // 其余仅保留有效类型名（STANDARD 或 数字_文字 格式），丢弃无效残留。
    let ss: string[] = (data && data.settings && data.settings.statScope) || [];
    if (typeof ss === "string") ss = [ss];
    const valid = (x: string) => C.STANDARD.includes(x) || C.isTypeFolder(x);
    const isOldDefault =
      ss.length > 0 &&
      ss.every((x) => C.STANDARD.includes(x)) &&
      C.STANDARD.every((x) => ss.includes(x));
    this.settings.statScope = isOldDefault ? [] : ss.filter(valid);
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ settings: this.settings, revisions: this.revisions });
  }

  private scheduleSaveRevisions(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.saveRevisionsNow();
    }, 1500);
  }

  private async saveRevisionsNow(): Promise<void> {
    this.saveTimer = null;
    await this.saveData({ settings: this.settings, revisions: this.revisions });
  }

  /* ---------------- 模型与结构 ---------------- */
  async refreshModel(): Promise<VaultModel> {
    this.model = await buildModel(this.app, this.settings.rootName);
    return this.model;
  }

  renderOpenView(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const l of leaves) {
      const v = l.view;
      if (v instanceof KanbanView) void v.render();
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshModel().then(() => this.renderOpenView());
    }, 400);
  }

  async ensureFolder(path: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const slash = path.lastIndexOf("/");
    if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    try {
      await this.app.vault.createFolder(path);
    } catch {
      /* 已存在则忽略 */
    }
  }

  // 确保某一级目录（灵感收集 / 各脑洞空间）下的「模板」子文件夹与三类模板文件齐备
  async ensureTemplateFiles(primary: string): Promise<void> {
    for (const type of Object.keys(C.TPL_FILE)) {
      const fname = C.TPL_FILE[type];
      const targetPath = `${primary}/模板/${fname}`;
      if (this.app.vault.getAbstractFileByPath(targetPath)) continue;
      let content = C.tplContent(type);
      const lib = this.app.vault.getAbstractFileByPath(
        `${C.TEMPLATE_LIBRARY}/${fname}`
      );
      if (lib instanceof TFile) {
        try {
          content = await this.app.vault.cachedRead(lib);
        } catch {
          /* 忽略，回退内置 */
        }
      }
      await this.ensureFolder(`${primary}/模板`);
      try {
        await this.app.vault.create(targetPath, content);
      } catch {
        /* 已存在则忽略 */
      }
    }
  }

  async ensureStructure(): Promise<void> {
    const rn = this.settings.rootName;
    await this.ensureFolder(rn);
    for (const sub of C.INSP_SUBFOLDERS) {
      await this.ensureFolder(`${rn}/${sub}`);
    }
    await this.ensureFolder(C.TEMPLATE_LIBRARY);
    for (const type of Object.keys(C.TPL_FILE)) {
      const p = `${C.TEMPLATE_LIBRARY}/${C.TPL_FILE[type]}`;
      if (!this.app.vault.getAbstractFileByPath(p)) {
        await this.app.vault.create(p, C.tplContent(type));
      }
    }
    await this.ensureTemplateFiles(rn);
    if (this.model) {
      for (const sp of this.model.spaces) {
        await this.ensureTemplateFiles(sp.path);
      }
    }
  }

  async bootstrapRevisions(): Promise<void> {
    const walk = (node: MNode) => {
      if (node.type === "note") {
        ensureRecord(
          this.revisions,
          node.path,
          node.words,
          node.created || Date.now()
        );
      } else {
        for (const c of node.children || []) walk(c);
      }
    };
    if (this.model) {
      for (const r of [
        this.model.inspRoot,
        this.model.library,
        ...this.model.spaces,
      ]) {
        if (r) walk(r);
      }
    }
    await this.saveRevisionsNow();
  }

  /* ---------------- 仓库事件 ---------------- */
  private onVaultChange(file: TAbstractFile): void {
    if (file instanceof TFile) {
      this.app.vault
        .cachedRead(file)
        .then((content) => {
          const chars = content.replace(/\s/g, "").length;
          recordModify(
            this.revisions,
            file.path,
            chars,
            firstLineSummary(content),
            Date.now()
          );
          this.scheduleSaveRevisions();
        })
        .catch(() => {
          /* 忽略读取失败 */
        });
    }
    this.scheduleRefresh();
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (file instanceof TFile) delete this.revisions[file.path];
    this.scheduleRefresh();
  }

  /* ---------------- 看板入口 ---------------- */
  async openKanban(): Promise<void> {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE);
    if (existing.length) {
      ws.revealLeaf(existing[0]);
      return;
    }
    const leaf = ws.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
  }

  // 映射当前库中的文件夹（文件夹映射向导，可随时重跑）
  openAdoption(): void {
    new AdoptionModal(this).open();
  }

  openRevision(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("没有正在编辑的文件");
      return;
    }
    new RevisionModal(this, file).open();
  }

  /* ---------------- 供视图调用的操作 ---------------- */
  async getTemplate(primary: string, type: string): Promise<string> {
    const f1 = this.app.vault.getAbstractFileByPath(
      `${primary}/模板/${C.TPL_FILE[type]}`
    );
    if (f1 instanceof TFile) {
      const c = await this.app.vault.cachedRead(f1);
      if (c.replace(/\s/g, "").length > 0) return c;
    }
    const f2 = this.app.vault.getAbstractFileByPath(
      `${C.TEMPLATE_LIBRARY}/${C.TPL_FILE[type]}`
    );
    if (f2 instanceof TFile) {
      try {
        return await this.app.vault.cachedRead(f2);
      } catch {
        /* 忽略 */
      }
    }
    return C.tplContent(type);
  }

  async quickCreate(path: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) {
      new Notice("目标文件夹不存在：" + path);
      return;
    }
    const parts = path.split("/");
    const primary = parts[0];
    const sub = parts[parts.length - 1];
    const type = C.templateTypeFor(sub);
    let content = (await this.getTemplate(primary, type)).replace(
      /\{\{date\}\}/g,
      C.todayStr()
    );
    let base = "新笔记",
      name = base + ".md",
      i = 1;
    const existing = (folder.children || []).map((c) => c.name);
    while (existing.includes(name)) name = `${base} ${i++}.md`;
    const file = await this.app.vault.create(`${path}/${name}`, content);
    new Notice(`已在「${path}」新建「${name}」`);
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  revealPath(path: string): void {
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!af) {
      new Notice("未找到：" + path);
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    if (leaves.length) {
      try {
        (leaves[0] as unknown as { revealInFolder: (f: TAbstractFile) => void }).revealInFolder(
          af
        );
      } catch {
        /* 文件栏不可用时忽略 */
      }
    }
    new Notice("已在文件栏定位：" + path);
  }

  openFilePath(path: string): void {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.app.workspace.getLeaf(true).openFile(f);
  }

  async createMissingTemplate(path: string): Promise<void> {
    const parts = path.split("/");
    const fname = parts[parts.length - 1];
    const type = Object.keys(C.TPL_FILE).find((k) => C.TPL_FILE[k] === fname);
    if (!type) {
      new Notice("无法识别模板类型");
      return;
    }
    const primary = parts[0];
    await this.ensureFolder(`${primary}/模板`);
    let content = C.tplContent(type);
    const lib = this.app.vault.getAbstractFileByPath(
      `${C.TEMPLATE_LIBRARY}/${fname}`
    );
    if (lib instanceof TFile) {
      try {
        content = await this.app.vault.cachedRead(lib);
      } catch {
        /* 忽略 */
      }
    }
    await this.app.vault.create(path, content);
    new Notice("已新建模板：" + path);
    this.openFilePath(path);
  }

  // 供视图使用：聚合热力图数据；prefix 限定只统计某子树（如灵感收集）
  heatmapMap(prefix?: string): Map<string, number> {
    const since = new Date();
    since.setDate(since.getDate() - 363);
    const sinceMs = since.getTime();
    const map = new Map<string, number>();
    for (const [path, rec] of Object.entries(this.revisions)) {
      if (prefix && !path.startsWith(prefix)) continue;
      for (const e of rec.history) {
        if (e.t < sinceMs || e.add <= 0) continue;
        const d = new Date(e.t);
        const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        map.set(key, (map.get(key) || 0) + e.add);
      }
    }
    return map;
  }

  // 供视图使用：定位节点
  nodeByPath(path: string): MNode | undefined {
    return this.model ? findNode(this.model, path) : undefined;
  }

  // 当前仓库中所有「类型」名（STANDARD ∪ 各脑洞下 数字_文字 子文件夹）
  allTypeNames(): string[] {
    const set = new Set<string>(C.STANDARD);
    const m = this.model;
    if (m) {
      for (const s of m.spaces) {
        for (const t of spaceTypes(s)) set.add(t.name);
      }
    }
    return [...set];
  }

  // 看板配置读写：statScope 为「排除列表」
  // 点击语义：当前全计入（空）→ 切到显式排除模式并排除该类型；
  //           否则在排除集中增删该项；清空后恢复「计入全部类型」。
  toggleScope(type: string): void {
    const all = this.allTypeNames();
    const s = this.settings.statScope.slice();
    if (s.length === 0) {
      this.settings.statScope = all.filter((n) => n !== type);
    } else if (s.includes(type)) {
      this.settings.statScope = s.filter((x) => x !== type);
    } else {
      this.settings.statScope = [...s, type];
    }
    void this.saveSettings();
  }

  moveTab(id: string, dir: "up" | "down"): void {
    const order = this.settings.kanbanOrder;
    const i = order.indexOf(id);
    if (i < 0) return;
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
    void this.saveSettings();
  }

  // 切换某子文件夹是否在卡片区展示
  toggleCardHidden(path: string): void {
    const h = this.settings.cardHidden;
    if (h[path]) delete h[path];
    else h[path] = true;
    void this.saveSettings();
  }

  toggleHide(id: string): void {
    this.settings.kanbanHidden[id] = !this.settings.kanbanHidden[id];
    void this.saveSettings();
  }

  setSpaceStatus(name: string, status: string): void {
    this.settings.spaceStatus[name] = status;
    void this.saveSettings();
  }

  setSpaceDesc(name: string, desc: string): void {
    this.settings.spaceDesc[name] = desc;
    void this.saveSettings();
  }
}

/* ====================== 弹窗 ====================== */

class NewSpaceModal extends Modal {
  private plugin: MeowbiusPlugin;
  private nameEl!: HTMLInputElement;
  private previewEl!: HTMLPreElement;

  constructor(plugin: MeowbiusPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "✨ 新建脑洞空间" });

    new Setting(contentEl).setName("脑洞空间名称（根目录下文件夹名）").addText((t) => {
      this.nameEl = t.inputEl;
      t.setPlaceholder("例如：赛博长安 / 深海恋人");
      t.inputEl.addEventListener("input", () => this.updatePreview());
    });

    new Setting(contentEl).setName("将在根目录创建（标准脑洞：7 个子文件夹 + 模板）").addText(() => {});
    this.previewEl = contentEl.createEl("pre", { cls: "mb-struct" });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("取消").onClick(() => this.close())
    ).addButton((b) =>
      b
        .setButtonText("创建")
        .setCta()
        .onClick(() => this.create())
    );

    this.updatePreview();
  }

  private updatePreview(): void {
    const name = (this.nameEl?.value || "").trim() || "〈脑洞名〉";
    const subs = C.STANDARD;
    let s = `${name}/\n`;
    subs.forEach((sub) => (s += `  📁 ${sub}/\n`));
    s += `  📁 模板/\n`;
    this.previewEl.textContent = s;
  }

  private async create(): Promise<void> {
    const name = (this.nameEl?.value || "").trim();
    if (!name) {
      new Notice("请先输入脑洞空间名称");
      return;
    }
    const rn = this.plugin.settings.rootName;
    if (name === rn || name === C.TEMPLATE_LIBRARY) {
      new Notice("该名称与系统目录冲突");
      return;
    }
    if (this.plugin.app.vault.getAbstractFileByPath(name)) {
      new Notice("已存在同名脑洞空间");
      return;
    }
    const subs = C.STANDARD;
    await this.plugin.ensureFolder(name);
    for (const sub of subs) await this.plugin.ensureFolder(`${name}/${sub}`);
    await this.plugin.ensureTemplateFiles(name);
    new Notice("已创建脑洞空间「" + name + "」");
    this.close();
    await this.plugin.refreshModel();
    await this.plugin.openKanban();
    this.plugin.renderOpenView();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class CaptureModal extends Modal {
  private plugin: MeowbiusPlugin;
  private targetEl!: HTMLSelectElement;
  private textEl!: HTMLTextAreaElement;

  constructor(plugin: MeowbiusPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "⚡ 快速捕捉：只言片语" });

    new Setting(contentEl).setName("存入位置").addDropdown((d) => {
      this.targetEl = d.selectEl;
      const model = this.plugin.model;
      if (model?.inspRoot) {
        const f = model.inspRoot.children?.find(
          (c) => c.type === "folder" && C.normalizeName(c.name) === C.normalizeName(C.STANDARD[3])
        );
        if (f) d.addOption(f.path, `${model.rootName} / ${f.name}`);
      }
      for (const sp of model?.spaces || []) {
        const f = sp.children?.find(
          (c) => c.type === "folder" && C.normalizeName(c.name) === C.normalizeName(C.STANDARD[3])
        );
        if (f) d.addOption(f.path, `${sp.name} / ${f.name}`);
      }
    });

    new Setting(contentEl).setName("内容").addTextArea((t) => {
      this.textEl = t.inputEl;
      t.setPlaceholder("灵光一现，先记下来再说…");
      t.inputEl.rows = 5;
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("保存碎片")
          .setCta()
          .onClick(() => this.save())
      );
  }

  private async save(): Promise<void> {
    const target = this.targetEl?.value;
    const text = (this.textEl?.value || "").trim();
    if (!target) {
      new Notice("请选择存入位置");
      return;
    }
    if (!text) {
      new Notice("写点什么再保存吧");
      return;
    }
    const d = new Date();
    const fname = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}-碎片.md`;
    const folder = this.plugin.app.vault.getAbstractFileByPath(target);
    if (!(folder instanceof TFolder)) {
      new Notice("目标文件夹不存在");
      return;
    }
    const existing = (folder.children || []).map((c) => c.name);
    let name = fname,
      i = 1;
    while (existing.includes(name)) name = `碎片 ${i++}.md`;
    const file = await this.plugin.app.vault.create(
      `${target}/${name}`,
      text
    );
    new Notice("已存入「" + target + "」：" + name);
    this.close();
    await this.plugin.app.workspace.getLeaf(true).openFile(file);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class RandomModal extends Modal {
  private plugin: MeowbiusPlugin;
  private fromEl!: HTMLDivElement;
  private contentEl2!: HTMLDivElement;

  constructor(plugin: MeowbiusPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  private collect(): { space: string; name: string; content: string }[] {
    const res: { space: string; name: string; content: string }[] = [];
    const model = this.plugin.model;
    if (!model) return res;
    const pushFrom = (node: MNode, space: string) => {
      const z = node.children?.find(
        (c) => c.type === "folder" && C.normalizeName(c.name) === C.normalizeName(C.STANDARD[3])
      );
      for (const n of z?.children || []) {
        if (n.type === "note") res.push({ space, name: n.name, content: "" });
      }
    };
    if (model.inspRoot) pushFrom(model.inspRoot, model.rootName);
    for (const sp of model.spaces) pushFrom(sp, sp.name);
    return res;
  }

  private async draw(): Promise<void> {
    const all = this.collect();
    if (!all.length) {
      new Notice("还没有只言片语可随机");
      return;
    }
    const pick = all[Math.floor(Math.random() * all.length)];
    const file = this.plugin.app.vault.getAbstractFileByPath(
      `${this.pickPath(pick)}`
    );
    let content = "（空笔记）";
    if (file instanceof TFile) {
      try {
        content = await this.plugin.app.vault.cachedRead(file);
      } catch {
        /* 忽略 */
      }
    }
    this.fromEl.textContent = `来自：「${pick.space} / 只言片语」· ${pick.name}`;
    this.contentEl2.textContent = content;
  }

  private pickPath(pick: { space: string; name: string }): string {
    return `${pick.space}/只言片语/${pick.name}`;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "🎲 随机灵感" });
    this.fromEl = contentEl.createDiv({ cls: "mb-label" });
    this.contentEl2 = contentEl.createDiv({
      attr: { style: "white-space:pre-wrap;line-height:1.7;" },
    });
    const bar = contentEl.createDiv({
      attr: { style: "margin-top:14px;display:flex;gap:10px;justify-content:flex-end;" },
    });
    const closeBtn = bar.createEl("button", { text: "关闭", cls: "mb-btn ghost" });
    closeBtn.addEventListener("click", () => this.close());
    const again = bar.createEl("button", { text: "再抽一条", cls: "mb-btn primary" });
    again.addEventListener("click", () => void this.draw());
    void this.draw();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class RevisionModal extends Modal {
  private plugin: MeowbiusPlugin;
  private file: TFile;

  constructor(plugin: MeowbiusPlugin, file: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "🕑 当前文件修订记录" });
    const rec = this.plugin.revisions[this.file.path];
    const created = rec?.created
      ? new Date(rec.created).toLocaleString("zh-CN")
      : new Date(this.file.stat.ctime).toLocaleString("zh-CN");
    contentEl.createEl("div", {
      text: `文件：${this.file.path}`,
      cls: "mb-label",
    });
    contentEl.createEl("div", {
      text: `创建时间：${created}`,
      attr: { style: "font-size:13px;margin:4px 0 10px;" },
    });
    const list = contentEl.createDiv({ cls: "rev-list" });
    const hist = rec?.history || [];
    if (!hist.length) {
      list.createDiv({ text: "（暂无修订记录）", cls: "mb-label" });
    }
    for (const e of hist) {
      const item = list.createDiv({ cls: "rev-item" });
      item.createDiv({
        text: new Date(e.t).toLocaleString("zh-CN"),
        cls: "rt",
      });
      const rd = item.createDiv({ cls: "rd" });
      rd.innerHTML = `<span class="add">＋${e.add} 字</span> &nbsp; <span class="del">－${e.del} 字</span>`;
      item.createDiv({ text: e.sn, cls: "rs" });
    }
    const bar = contentEl.createDiv({
      attr: { style: "margin-top:12px;display:flex;justify-content:flex-end;" },
    });
    const closeBtn = bar.createEl("button", { text: "关闭", cls: "mb-btn ghost" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ====================== 设置页 ====================== */

class MeowbiusSettingTab extends PluginSettingTab {
  private plugin: MeowbiusPlugin;

  constructor(plugin: MeowbiusPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Meowbius_S.S 设置" });

    new Setting(containerEl)
      .setName("灵感收集根目录名")
      .addText((t) =>
        t
          .setPlaceholder("灵感收集")
          .setValue(this.plugin.settings.rootName)
          .onChange(async (v) => {
            const name = v.trim();
            if (name) {
              this.plugin.settings.rootName = name;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
