// 插件常量与内置模板

export const STATUSES = ["前期准备", "口嗨中", "填坑中", "已完成"] as const;
export type Status = typeof STATUSES[number];

// 标准脑洞空间的 7 个子文件夹（两位数字前缀、从 00 开始编号，便于排序）
export const STANDARD = [
  "00_世界观设定",
  "01_时间轴",
  "02_人物",
  "03_只言片语",
  "04_片段口嗨",
  "05_已整理",
  "06_衍生脑洞",
];

// 灵感收集根目录下的 4 个子文件夹
export const INSP_SUBFOLDERS = ["脑洞", "大纲", "只言片语", "知识补充"];

// 根「模板库」与各一级目录「模板」子文件夹下的模板文件
export const TPL_FILE: Record<string, string> = {
  brain: "脑洞卡模板.md",
  frag: "只言片语模板.md",
  gen: "通用笔记模板.md",
};

export const TPL_TYPES = [
  { k: "brain", label: "脑洞卡" },
  { k: "frag", label: "只言片语" },
  { k: "gen", label: "通用笔记" },
];

export const TEMPLATE_LIBRARY = "模板库";

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// 内置默认模板内容（{{date}} 由调用处替换为当天日期）
export function tplContent(type: string): string {
  const d = todayStr();
  if (type === "brain")
    return `---\ntype: 脑洞\nstatus: 前期准备\ntags: []\ncreated: ${d}\n时间: \n灵感来源: \n核心概念: \n关联脑洞: \n---\n\n# 脑洞标题\n\n`;
  if (type === "frag")
    return `---\ntype: 碎片\ncreated: ${d}\n时间: \n灵感来源: \ntags: []\n---\n\n`;
  return `---\ntype: 笔记\ncreated: ${d}\n时间: \n灵感来源: \n---\n\n`;
}

// 根据子文件夹名推断应套用的模板类型
export function templateTypeFor(sub: string): string {
  if (sub === "脑洞" || sub === "衍生脑洞") return "brain";
  if (sub === "只言片语") return "frag";
  return "gen";
}

// 规范化文件夹名：去数字前缀与常见后缀，取核心词
export function normalizeName(s: string): string {
  return s
    .replace(/^\d+[._\-\s]*/, "")
    .replace(/(设定|笔记|资料|文件夹|稿|doc|note)$/i, "")
    .trim();
}

// 是否「类型」文件夹：名称形如 数字_文字（如 00_世界观设定 / 07_设定集）
export function isTypeFolder(name: string): boolean {
  return /^\d+_/.test(name);
}
