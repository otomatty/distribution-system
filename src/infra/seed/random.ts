/**
 * テストデータ用の、種を固定した疑似乱数（要件定義書 9章：同じ種なら毎回同じデータ）。
 * Math.random は使わない。決める対象ごと（日付・伝票の番号など）に種を分けるので、
 * 投入を何回に分けて実行しても、同じ対象には同じ乱数が出る。
 */

/** 文字列から32ビットの種を作る（FNV-1a） */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** 0 以上 1 未満（mulberry32） */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** min 以上 max 以下の整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** 確率 p で true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(list: readonly T[]): T {
    const v = list[Math.floor(this.next() * list.length)];
    if (v === undefined) throw new RangeError("pick: 空の一覧からは選べません");
    return v;
  }

  /** 重みに比例して1つ選ぶ */
  weighted<T>(list: readonly T[], weight: (item: T) => number): T {
    const total = list.reduce((s, x) => s + weight(x), 0);
    let r = this.next() * total;
    for (const x of list) {
      r -= weight(x);
      if (r < 0) return x;
    }
    return this.pick(list);
  }

  /** 重複なしで n 個選ぶ（重みつき） */
  weightedSample<T>(list: readonly T[], n: number, weight: (item: T) => number): T[] {
    const pool = [...list];
    const out: T[] = [];
    while (out.length < n && pool.length > 0) {
      const chosen = this.weighted(pool, weight);
      out.push(chosen);
      pool.splice(pool.indexOf(chosen), 1);
    }
    return out;
  }

  /** 平均 mean のポアソン分布に近い整数（件数のばらつき用） */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    // 平均が大きいときは正規分布で近似する
    if (mean > 30) {
      const u = Math.max(this.next(), 1e-9);
      const v = this.next();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return Math.max(0, Math.round(mean + z * Math.sqrt(mean)));
    }
    const limit = Math.exp(-mean);
    let k = 0;
    let p = this.next();
    while (p > limit) {
      k += 1;
      p *= this.next();
    }
    return k;
  }
}

/** 投入全体の種と、決める対象の名前から乱数を作る */
export function randomFor(seed: number, ...keys: readonly (string | number)[]): Random {
  return new Random(hash32(`${seed}:${keys.join(":")}`));
}
