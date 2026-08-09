// 把 Obsidian 仓库扫描成树状模型，并提供字数 / 状态 / 占比等统计
import { App, TFile, TFolder } from "obsidian";
import { TEMPLATE_LIBRARY, STANDARD, normalizeName, isTypeFolder } from "./constants";

export interface MNode {
  name: string;
  path: string;
  type: "folder" | "note";
  children?: MNode[];
  words: number; // 去空白字符数
  notes: number; // 子孙笔记数
  status?: string;
  date?: string; // 时间轴笔记的日期
  created?: number;
  mtime?: number;
}

export interface VaultModel {
  root: MNode; // 仓库根（合成节点，path 为空）
  map: Map<string, MNode>;
  rootName: string; // 灵感收集根目录名
  inspRoot?: MNode; // 灵感收集节点
  library?: MNode; // 模板库节点
  spaces: MNode[]; // 脑洞空间（顶级文件夹，排除 rootName 与 模板库）
}

// 时间轴节点（取自脑洞空间下「时间轴」文件夹中的每个笔记）
export interface TimelineEntry {
  path: string; // 笔记完整路径
  name: string; // 文件名（含 .md）
  title: string; // 去数字前缀与扩展名后的标题
  mtime: number; // 最近修改时间
  words: number; // 字数（去空白字符数）
  snippet: string; // 正文摘要（剥 frontmatter，前 ~120 字）
}

export function findNode(model: VaultModel, path: string): MNode | undefined {
  return model.map.get(path);
}

export function yearWords(node: MNode, year: number): number {
  if (node.type === "note") {
    return node.mtime && new Date(node.mtime).getFullYear() === year
      ? node.words
      : 0;
  }
  let s = 0;
  for (const c of node.children || []) s += yearWords(c, year);
  return s;
}

// 取脑洞空间下所有「类型」子文件夹（名称形如 数字_文字）
export function spaceTypes(node: MNode): MNode[] {
  return (node.children || []).filter(
    (c) => c.type === "folder" && isTypeFolder(c.name)
  );
}

// 统计范围内（子文件夹类型）的字数 / 文件数 / 今年更新字数
// statScope 为「排除列表」：空 = 计入全部类型文件夹；否则排除其中列出的类型。
// 匹配按规范化核心词，使 人物 / 03_人物 / 02_人物 都能正确归类。
export function scopeStats(space: MNode, statScope: string[]) {
  let w = 0,
    n = 0,
    y = 0;
  const year = new Date().getFullYear();
  const excl = statScope.map(normalizeName);
  for (const ch of space.children || []) {
    if (
      ch.type === "folder" &&
      isTypeFolder(ch.name) &&
      (excl.length === 0 || !excl.includes(normalizeName(ch.name)))
    ) {
      w += ch.words;
      n += ch.notes;
      y += yearWords(ch, year);
    }
  }
  return { w, n, y };
}

// 角色词云：取各脑洞「人物」文件夹下的笔记（名称→篇幅）
export function collectCharacters(model: VaultModel, statScope: string[]) {
  const charCore = normalizeName(STANDARD[2]);
  const excl = statScope.map(normalizeName);
  if (excl.length > 0 && excl.includes(charCore)) return [];
  const map: Record<string, number> = {};
  for (const s of model.spaces) {
    const pf = s.children?.find(
      (f) =>
        f.type === "folder" && normalizeName(f.name) === charCore
    );
    if (!pf) continue;
    for (const n of pf.children || []) {
      if (n.type === "note") {
        const k = n.name.replace(/\.md$/, "");
        map[k] = (map[k] || 0) + n.words;
      }
    }
  }
  return Object.entries(map)
    .map(([name, w]) => ({ name, w }))
    .sort((a, b) => b.w - a.w);
}

function computeAggregates(node: MNode): void {
  if (node.type === "note") return;
  let w = 0,
    n = 0;
  for (const c of node.children || []) {
    computeAggregates(c);
    w += c.words;
    n += c.notes;
  }
  node.words = w;
  node.notes = n;
}

function collectNotes(node: MNode, acc: MNode[]): void {
  if (node.type === "note") {
    acc.push(node);
    return;
  }
  for (const c of node.children || []) collectNotes(c, acc);
}

export async function buildModel(
  app: App,
  rootName: string
): Promise<VaultModel> {
  const files = app.vault.getAllLoadedFiles();
  const map = new Map<string, MNode>();
  const root: MNode = {
    name: "",
    path: "",
    type: "folder",
    children: [],
    words: 0,
    notes: 0,
  };

  const notes: MNode[] = [];
  for (const f of files) {
    if (f instanceof TFolder) {
      map.set(f.path, {
        name: f.name,
        path: f.path,
        type: "folder",
        children: [],
        words: 0,
        notes: 0,
      });
    } else if (f instanceof TFile) {
      const cache = app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter;
      const node: MNode = {
        name: f.name,
        path: f.path,
        type: "note",
        words: 0,
        notes: 1,
        status:
          typeof fm?.status === "string" ? fm.status : undefined,
        date: typeof fm?.date === "string" ? fm.date : undefined,
        created: f.stat.ctime,
        mtime: f.stat.mtime,
      };
      map.set(f.path, node);
      notes.push(node);
    }
  }

  // 关联父节点
  for (const [path, node] of map) {
    if (!path) continue;
    const slash = path.lastIndexOf("/");
    const parentPath = slash >= 0 ? path.slice(0, slash) : "";
    const parent = map.get(parentPath) || root;
    parent.children!.push(node);
  }

  const inspRoot = root.children?.find(
    (c) => c.name === rootName && c.type === "folder"
  );
  const library = root.children?.find(
    (c) => c.name === TEMPLATE_LIBRARY && c.type === "folder"
  );
  const spaces = (root.children || []).filter(
    (c) =>
      c.type === "folder" &&
      c.name !== rootName &&
      c.name !== TEMPLATE_LIBRARY
  );

  // 仅读取相关子树下的笔记内容（避免读取仓库中无关笔记）
  const relevant = [inspRoot, library, ...spaces].filter(
    (n): n is MNode => !!n
  );
  const toRead: MNode[] = [];
  for (const r of relevant) collectNotes(r, toRead);

  await Promise.all(
    toRead.map(async (node) => {
      const file = app.vault.getAbstractFileByPath(node.path);
      if (file instanceof TFile) {
        try {
          const content = await app.vault.cachedRead(file);
          node.words = content.replace(/\s/g, "").length;
        } catch {
          node.words = 0;
        }
      }
    })
  );

  computeAggregates(root);

  return { root, map, rootName, inspRoot, library, spaces };
}
