// 文件夹映射向导：列出所有一级文件夹，逐个决定 保留 / 删除 / 映射至插件结构
import { Modal, Notice, TFolder } from "obsidian";
import type MeowbiusPlugin from "./main";
import { STANDARD, INSP_SUBFOLDERS, TEMPLATE_LIBRARY } from "./constants";

/** 向导中每一行代表一个一级文件夹 */
interface FolderRow {
  path: string;
  name: string;
}

/** 一条映射计划：把源文件夹映射到某个父级（或直接并入其某子文件夹） */
interface MapPlan {
  from: string; // 源一级文件夹路径
  kind: "child" | "merge"; // child=作为父级的直接子文件夹；merge=并入父级的指定子文件夹
  parent: string; // 解析后的父级路径（可能是新建脑洞空间的路径）
  sub?: string; // merge 时的具体子文件夹名
  newSpace?: string; // 若需新建脑洞空间，则其名称
}

const SKIP_ROOTS = new Set([".obsidian", ".trash", ".git"]);
const NEW_SPACE_OPT = "__new_space__";
const CHILD_OPT = "__child__";

export class AdoptionModal extends Modal {
  private plugin: MeowbiusPlugin;
  private rows: FolderRow[] = [];

  constructor(plugin: MeowbiusPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.detect();
  }

  // ── 检测：收集所有一级文件夹（排除系统目录与插件自身管理的根目录）──
  private detect(): void {
    const app = this.plugin.app;
    const rn = this.plugin.settings.rootName;
    const skip = new Set(SKIP_ROOTS);
    skip.add(rn);
    skip.add(TEMPLATE_LIBRARY);

    for (const f of app.vault.getAllLoadedFiles()) {
      if (!(f instanceof TFolder)) continue;
      if (f.path.includes("/")) continue; // 仅一级文件夹
      if (skip.has(f.path)) continue;
      this.rows.push({ path: f.path, name: f.name });
    }
  }

  // 已存在的脑洞空间（用于"单个脑洞"候选，排除自身与系统目录）
  private existingSpaces(excludePath: string): string[] {
    return this.rows.filter((r) => r.path !== excludePath).map((r) => r.name);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "🧭 文件夹映射" });

    if (!this.rows.length) {
      contentEl.createEl("p", {
        text: "未检测到需要处理的一级文件夹，插件将按默认结构初始化。",
      });
      const bar = contentEl.createDiv({ cls: "mb-row end" });
      bar
        .createEl("button", { text: "完成", cls: "mb-btn" })
        .addEventListener("click", () => void this.commit([], []));
      return;
    }

    this.rows.forEach((r, i) => this.renderRow(r, i));

    const bar = contentEl.createDiv({ cls: "mb-row end" });
    bar
      .createEl("button", { text: "取消", cls: "mb-btn ghost" })
      .addEventListener("click", () => this.close());
    bar
      .createEl("button", { text: "确认", cls: "mb-btn" })
      .addEventListener("click", () => this.confirm());
  }

  // ── 渲染一行：名称 + 保留 / 删除 / 映射至（级联路径选择） ──
  private renderRow(r: FolderRow, i: number): void {
    const row = this.contentEl.createDiv({ cls: "adopt-row" });
    row.createSpan({ text: r.name, cls: "adopt-name" });
    const grp = row.createDiv({ cls: "adopt-opts" });

    // 保留（默认）
    grp.createEl("label").createEl("input", {
      type: "radio",
      attr: { name: `row${i}`, value: "keep", checked: true },
    }).parentElement!.appendText(" 保留");

    // 删除（回收站）
    grp.createEl("label").createEl("input", {
      type: "radio",
      attr: { name: `row${i}`, value: "delete" },
    }).parentElement!.appendText(" 删除（回收站）");

    // 映射至
    const mapLabel = grp.createEl("label");
    mapLabel.createEl("input", {
      type: "radio",
      attr: { name: `row${i}`, value: "map" },
    });
    mapLabel.appendText(" 映射至 ");

    // 级联容器（默认隐藏，选中"映射至"后展开）
    const cascade = row.createDiv({ cls: "adopt-map" });
    cascade.style.display = "none";

    // 第一级：大类
    const catSel = cascade.createEl("select", {
      cls: "adopt-sel adopt-cat",
      attr: { id: `cat${i}` },
    });
    for (const c of ["灵感收集", "单个脑洞", "模板库"]) {
      catSel.createEl("option", { text: c, value: c });
    }

    // 第二/三级：随大类动态渲染
    const branch = cascade.createEl("div", {
      cls: "adopt-branch",
      attr: { id: `branch${i}` },
    });

    const renderBranch = () => {
      branch.empty();
      const cat = catSel.value;
      if (cat === "灵感收集") {
        const sel = branch.createEl("select", {
          cls: "adopt-sel",
          attr: { id: `lc_sub${i}` },
        });
        sel.createEl("option", { text: "作为子文件夹", value: CHILD_OPT });
        for (const s of INSP_SUBFOLDERS) {
          sel.createEl("option", { text: s, value: s });
        }
      } else if (cat === "模板库") {
        const sel = branch.createEl("select", {
          cls: "adopt-sel",
          attr: { id: `lib_sub${i}` },
        });
        sel.createEl("option", { text: "作为子文件夹", value: CHILD_OPT });
      } else {
        // 单个脑洞：先选脑洞（已有空间 / 新建），再选其子文件夹
        const spSel = branch.createEl("select", {
          cls: "adopt-sel adopt-cat",
          attr: { id: `sp_sel${i}` },
        });
        for (const s of this.existingSpaces(r.path)) {
          spSel.createEl("option", { text: s, value: s });
        }
        spSel.createEl("option", { text: "＋新建脑洞…", value: NEW_SPACE_OPT });

        const nameInput = branch.createEl("input", {
          type: "text",
          cls: "adopt-name-input",
          attr: { id: `sp_new${i}`, placeholder: "新脑洞名称" },
        });
        nameInput.value = r.name;
        nameInput.style.display = "none";

        const subSel = branch.createEl("select", {
          cls: "adopt-sel",
          attr: { id: `sp_sub${i}` },
        });
        subSel.createEl("option", { text: "作为子文件夹", value: CHILD_OPT });
        for (const s of STANDARD) {
          subSel.createEl("option", { text: s, value: s });
        }

        spSel.addEventListener("change", () => {
          nameInput.style.display =
            spSel.value === NEW_SPACE_OPT ? "" : "none";
        });
      }
    };
    renderBranch();
    catSel.addEventListener("change", renderBranch);

    // 选中"映射至"才展开级联
    grp.querySelectorAll("input[type=radio]").forEach((radio) => {
      radio.addEventListener("change", () => {
        cascade.style.display =
          (radio as HTMLInputElement).value === "map" ? "flex" : "none";
      });
    });
  }

  // ── 读取某一行的映射计划 ──
  private readPlan(i: number, r: FolderRow): MapPlan | null {
    const cat = (
      this.contentEl.querySelector(`#cat${i}`) as HTMLSelectElement | null
    )?.value;
    if (cat === "灵感收集") {
      const sub = (
        this.contentEl.querySelector(`#lc_sub${i}`) as HTMLSelectElement
      ).value;
      if (sub === CHILD_OPT) {
        return {
          from: r.path,
          kind: "child",
          parent: this.plugin.settings.rootName,
        };
      }
      return {
        from: r.path,
        kind: "merge",
        parent: this.plugin.settings.rootName,
        sub,
      };
    }
    if (cat === "模板库") {
      return { from: r.path, kind: "child", parent: TEMPLATE_LIBRARY };
    }
    // 单个脑洞
    const spVal = (
      this.contentEl.querySelector(`#sp_sel${i}`) as HTMLSelectElement
    ).value;
    const sub = (
      this.contentEl.querySelector(`#sp_sub${i}`) as HTMLSelectElement
    ).value;
    if (spVal === NEW_SPACE_OPT) {
      const nm = (
        (this.contentEl.querySelector(`#sp_new${i}`) as HTMLInputElement)
          .value || ""
      ).trim() || r.name;
      const plan: MapPlan = {
        from: r.path,
        kind: sub === CHILD_OPT ? "child" : "merge",
        parent: nm,
        newSpace: nm,
      };
      if (sub !== CHILD_OPT) plan.sub = sub;
      return plan;
    }
    const plan: MapPlan = {
      from: r.path,
      kind: sub === CHILD_OPT ? "child" : "merge",
      parent: spVal,
    };
    if (sub !== CHILD_OPT) plan.sub = sub;
    return plan;
  }

  // ── 收集用户选择 ──
  private confirm(): void {
    const deletions: string[] = [];
    const maps: MapPlan[] = [];

    for (let i = 0; i < this.rows.length; i++) {
      const v = (
        this.contentEl.querySelector(
          `input[name="row${i}"]:checked`
        ) as HTMLInputElement | null
      )?.value;
      if (v === "delete") {
        deletions.push(this.rows[i].path);
      } else if (v === "map") {
        const plan = this.readPlan(i, this.rows[i]);
        if (plan) maps.push(plan);
      }
    }

    if (deletions.length) {
      this.showDanger(deletions, maps);
      return;
    }
    void this.commit(maps, deletions);
  }

  // ── 危险确认页（删除操作）──
  private showDanger(deletions: string[], maps: MapPlan[]): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mb-modal");
    contentEl.createEl("h3", { text: "⚠️ 确认删除" });
    const warn = contentEl.createEl("p", { cls: "mb-danger" });
    warn.textContent = `以下 ${deletions.length} 个文件夹将被移入 Obsidian 回收站（.trash，可恢复，非永久删除）。请确认你确实要移除它们：`;
    const list = contentEl.createEl("div", { cls: "adopt-del-list" });
    for (const p of deletions) list.createEl("div", { text: p });

    const bar = contentEl.createDiv({ cls: "mb-row end" });
    bar
      .createEl("button", { text: "返回", cls: "mb-btn ghost" })
      .addEventListener("click", () => this.onOpen());
    bar
      .createEl("button", { text: "确认删除并接入", cls: "mb-btn danger" })
      .addEventListener("click", () => void this.commit(maps, deletions));
  }

  // ── 执行：删除 + 映射 ──
  private async commit(
    maps: MapPlan[],
    deletions: string[]
  ): Promise<void> {
    const app = this.plugin.app;

    // 1. 删除（走回收站）
    for (const d of deletions) {
      const f = app.vault.getAbstractFileByPath(d);
      if (f) {
        try {
          await app.vault.trash(f, true);
        } catch {
          /* 忽略 */
        }
      }
    }

    // 2. 映射
    for (const m of maps) {
      const src = app.vault.getAbstractFileByPath(m.from);
      if (!(src instanceof TFolder)) continue;

      // 若需新建脑洞空间：创建空间 + 7 个标准子文件夹 + 模板
      if (m.newSpace) {
        const sp = m.newSpace;
        await this.plugin.ensureFolder(sp);
        for (const s of STANDARD) {
          await this.plugin.ensureFolder(`${sp}/${s}`);
        }
        await this.plugin.ensureTemplateFiles(sp);
      }

      // 解析目标路径
      const targetPath =
        m.kind === "child"
          ? `${m.parent}/${src.name}`
          : `${m.parent}/${m.sub}`;

      // child 且目标不存在：直接把整个源文件夹改名搬过去（无需逐子项移动）
      if (m.kind === "child" && !app.vault.getAbstractFileByPath(targetPath)) {
        try {
          await app.vault.rename(src, targetPath);
        } catch {
          /* 忽略 */
        }
        continue;
      }

      // 其余情况：确保目标文件夹存在 → 把源内子项移入 → 回收源文件夹
      let target = app.vault.getAbstractFileByPath(targetPath);
      if (!target) {
        try {
          await app.vault.createFolder(targetPath);
          target = app.vault.getAbstractFileByPath(targetPath);
        } catch {
          /* 忽略 */
        }
      }
      if (target instanceof TFolder) {
        await this.moveChildrenInto(src, target);
        try {
          await app.vault.trash(src, false);
        } catch {
          /* 忽略 */
        }
      }
    }

    // 3. 写标记、补缺结构、刷新
    this.plugin.settings.initialized = true;
    await this.plugin.saveSettings();
    try {
      await this.plugin.ensureStructure();
    } catch {
      /* 忽略 */
    }
    this.plugin.model = await this.plugin.refreshModel();
    this.plugin.renderOpenView();
    new Notice("Meowbius_S.S：文件夹映射完成");
    this.close();
  }

  /** 将 src 内的所有文件/子文件夹移入 target */
  private async moveChildrenInto(
    src: TFolder,
    target: TFolder
  ): Promise<void> {
    const children = [...(src.children || [])];
    for (const child of children) {
      try {
        const newPath = `${target.path}/${child.name}`;
        // 若目标下已有同名文件，跳过避免冲突
        if (this.plugin.app.vault.getAbstractFileByPath(newPath)) continue;
        await this.plugin.app.vault.rename(child, newPath);
      } catch {
        /* 单个失败不阻断整体 */
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
