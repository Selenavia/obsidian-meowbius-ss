// 修订记录追踪：每个文件一条记录，包含创建时间与修改历史（增/删字数）

export interface RevEntry {
  t: number; // 时间戳（ms）
  add: number; // 本次新增字数
  del: number; // 本次删除字数
  sn: string; // 改动摘要
}

export interface RevRecord {
  created: number; // 创建时间戳
  chars: number; // 最近一次记录时的字数（去空白）
  history: RevEntry[]; // 修改历史（最新在前）
}

export type Revisions = Record<string, RevRecord>;

const MAX_HISTORY = 60;

// 确保文件存在一条记录（用于插件启动时对已有文件做基线登记）
export function ensureRecord(
  revs: Revisions,
  path: string,
  chars: number,
  created: number
): RevRecord {
  if (!revs[path]) {
    revs[path] = {
      created,
      chars,
      history: [{ t: created, add: chars, del: 0, sn: "（创建）" }],
    };
  }
  return revs[path];
}

// 记录一次修改：依据新旧字数之差计算增/删
export function recordModify(
  revs: Revisions,
  path: string,
  newChars: number,
  sn: string,
  now: number
): RevRecord {
  let rec = revs[path];
  if (!rec) {
    rec = { created: now, chars: newChars, history: [] };
  }
  const add = Math.max(0, newChars - rec.chars);
  const del = Math.max(0, rec.chars - newChars);
  if (add > 0 || del > 0) {
    rec.history.unshift({ t: now, add, del, sn: sn || "" });
    if (rec.history.length > MAX_HISTORY) rec.history.length = MAX_HISTORY;
  }
  rec.chars = newChars;
  revs[path] = rec;
  return rec;
}

// 聚合近 12 个月逐日活动强度（用于热力图），返回 Date(天) -> 强度
export function heatmapFromRevisions(
  revs: Revisions,
  since: number
): Map<string, number> {
  const map = new Map<string, number>();
  for (const rec of Object.values(revs)) {
    for (const e of rec.history) {
      if (e.t < since) continue;
      if (e.add <= 0) continue;
      const d = new Date(e.t);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      map.set(key, (map.get(key) || 0) + e.add);
    }
  }
  return map;
}
