/**
 * テストデータの名前・連絡先。実在の会社や個人と取り違えないよう、すべて架空とわかる形にする
 * （社名に「サンプル」「見本」「テスト」「架空」を入れる、住所は「架空県見本市」、メールは example.co.jp、
 * 電話は 0192-00-xxxx、郵便番号は 000 で始める、JAN は店内用の 2 で始める）。個人情報は含めない。
 */
import type { Random } from "./random";

const MARKERS = [
  ["サンプル", "さんぷる"],
  ["見本", "みほん"],
  ["テスト", "てすと"],
  ["架空", "かくう"],
] as const;

/** 地名の代わりに使う言葉（ひらがななので読み仮名もそのまま） */
export const PLACE_WORDS = [
  "あおば",
  "あかね",
  "あさひ",
  "いずみ",
  "うみかぜ",
  "かえで",
  "かすみ",
  "きぼう",
  "くじら",
  "こはく",
  "さくら",
  "しおさい",
  "すずらん",
  "そよかぜ",
  "たんぽぽ",
  "つばき",
  "ときわ",
  "なぎさ",
  "のぞみ",
  "はまなす",
  "ひかり",
  "ひなた",
  "ふじ",
  "ほたる",
  "まつかぜ",
  "みなと",
  "みどり",
  "もみじ",
  "やまびこ",
  "ゆうひ",
  "よつば",
  "わかば",
  "かもめ",
  "いちょう",
  "しらかば",
  "つくし",
  "なのはな",
  "ひまわり",
  "あじさい",
  "すみれ",
] as const;

/** 仕入先の業種。maker はメーカー直（販売先へ直送）を受けることがある業種 */
const SUPPLIER_TYPES = [
  { name: "製菓", kana: "せいか", maker: false },
  { name: "食品", kana: "しょくひん", maker: false },
  { name: "水産", kana: "すいさん", maker: true },
  { name: "菓子舗", kana: "かしほ", maker: false },
  { name: "農園", kana: "のうえん", maker: true },
  { name: "酒造", kana: "しゅぞう", maker: true },
  { name: "牧場", kana: "ぼくじょう", maker: true },
  { name: "製麺", kana: "せいめん", maker: false },
  { name: "珈琲", kana: "こーひー", maker: false },
  { name: "茶園", kana: "ちゃえん", maker: true },
  { name: "製パン", kana: "せいぱん", maker: false },
  { name: "醸造", kana: "じょうぞう", maker: false },
  { name: "冷凍食品", kana: "れいとうしょくひん", maker: false },
  { name: "包装資材", kana: "ほうそうしざい", maker: false },
  { name: "工芸", kana: "こうげい", maker: false },
] as const;

const CUSTOMER_TYPES = [
  { name: "商店", kana: "しょうてん" },
  { name: "ストア", kana: "すとあ" },
  { name: "マート", kana: "まーと" },
  { name: "百貨店", kana: "ひゃっかてん" },
  { name: "旅館", kana: "りょかん" },
  { name: "ホテル", kana: "ほてる" },
  { name: "カフェ", kana: "かふぇ" },
  { name: "売店", kana: "ばいてん" },
  { name: "土産店", kana: "みやげてん" },
  { name: "市場", kana: "いちば" },
  { name: "スーパー", kana: "すーぱー" },
  { name: "直売所", kana: "ちょくばいじょ" },
  { name: "食堂", kana: "しょくどう" },
  { name: "観光センター", kana: "かんこうせんたー" },
] as const;

/** 仕入先・販売先の両方の取引先の業種 */
const BOTH_TYPES = [
  { name: "物産", kana: "ぶっさん" },
  { name: "商事", kana: "しょうじ" },
  { name: "道の駅", kana: "みちのえき" },
  { name: "協同組合", kana: "きょうどうくみあい" },
] as const;

const GIVEN_NAMES = [
  ["一郎", "いちろう"],
  ["花子", "はなこ"],
  ["次郎", "じろう"],
  ["桜", "さくら"],
  ["三郎", "さぶろう"],
  ["葵", "あおい"],
  ["健", "けん"],
  ["光", "ひかる"],
] as const;

export type PartnerKind = "supplier" | "customer" | "both";

export interface PartnerSpec {
  /** 作る順（0 から） */
  readonly index: number;
  readonly kind: PartnerKind;
  readonly name: string;
  readonly kana: string;
  readonly honorific: "御中" | "様";
  /** メーカー直を受けることがある仕入先 */
  readonly maker: boolean;
  readonly contactName: string | null;
  readonly postalCode: string;
  readonly address: string;
  readonly phone: string;
  readonly mobile: string | null;
  readonly fax: string | null;
  readonly email: string | null;
  readonly lineId: string | null;
  readonly mainContact: "email" | "fax" | "phone" | "line" | null;
  readonly deliveryDays: number;
  readonly defaultSendMethod: "email" | "none";
  readonly mailOrderAllowed: boolean;
  readonly placeName: string;
  readonly registrationNumber: string | null;
  readonly terms: {
    readonly closingDay: number;
    readonly paymentMonthOffset: number;
    readonly paymentDay: number;
  } | null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** 架空の住所（000 で始まる郵便番号、架空県見本市） */
export function fictionalAddress(n: number): { postalCode: string; address: string } {
  const place = PLACE_WORDS[n % PLACE_WORDS.length] ?? "あおば";
  return {
    postalCode: `000${pad(n % 10_000, 4)}`,
    address: `架空県見本市${place}町${(n % 9) + 1}-${(n % 27) + 1}-${(n % 13) + 1}`,
  };
}

export function fictionalPhone(prefix: "00" | "01", n: number): string {
  return `0192-${prefix}-${pad(n % 10_000, 4)}`;
}

/** 取引先の一覧（仕入先だけ → 販売先だけ → 両方の順）。同じ件数なら毎回同じ内容 */
export function partnerSpecs(
  random: Random,
  counts: { suppliers: number; customers: number; both: number },
): PartnerSpec[] {
  const used = new Set<string>();
  const out: PartnerSpec[] = [];
  const kinds: PartnerKind[] = [
    ...Array.from({ length: counts.suppliers }, (): PartnerKind => "supplier"),
    ...Array.from({ length: counts.customers }, (): PartnerKind => "customer"),
    ...Array.from({ length: counts.both }, (): PartnerKind => "both"),
  ];
  for (const [index, kind] of kinds.entries()) {
    const n = index + 1;
    const individual = kind === "customer" && random.chance(0.05);
    let name = "";
    let kana = "";
    let maker = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [marker, markerKana] = random.pick(MARKERS);
      const place = random.pick(PLACE_WORDS);
      if (individual) {
        const [given, givenKana] = random.pick(GIVEN_NAMES);
        name = `${marker} ${given}（${place}）`;
        kana = `${markerKana}${givenKana}${place}`;
      } else {
        const type =
          kind === "supplier"
            ? random.pick(SUPPLIER_TYPES)
            : kind === "customer"
              ? random.pick(CUSTOMER_TYPES)
              : random.pick(BOTH_TYPES);
        maker = "maker" in type && type.maker;
        const legal = random.pick(["株式会社", "有限会社", "合同会社", "", "株式会社"] as const);
        const core = `${marker}${place}${type.name}`;
        name = legal === "" ? core : random.chance(0.6) ? `${legal}${core}` : `${core}${legal}`;
        kana = `${markerKana}${place}${type.kana}`;
      }
      if (!used.has(name)) break;
    }
    if (used.has(name)) name = `${name}${n}`;
    used.add(name);
    const { postalCode, address } = fictionalAddress(n);
    const isCustomer = kind !== "supplier";
    const isSupplier = kind !== "customer";
    const hasEmail = random.chance(isSupplier ? 0.7 : 0.6);
    const email = hasEmail ? `partner${pad(n, 4)}@example.co.jp` : null;
    const hasFax = random.chance(0.6);
    const contactSeed = random.pick(GIVEN_NAMES);
    // 取引条件：仕入先の多くと、販売先の4割ほどは月締め（締め日の翌月払い）
    const termsRate = kind === "supplier" ? 0.7 : kind === "both" ? 0.6 : 0.4;
    const terms = random.chance(termsRate)
      ? {
          closingDay: random.pick([20, 25, 31, 31, 31] as const),
          paymentMonthOffset: random.pick([1, 1, 1, 2] as const),
          paymentDay: random.pick([10, 15, 31, 31] as const),
        }
      : null;
    out.push({
      index,
      kind,
      name,
      kana,
      honorific: individual ? "様" : "御中",
      maker,
      contactName: individual ? null : `見本 ${contactSeed[0]}`,
      postalCode,
      address,
      phone: fictionalPhone("00", n),
      mobile: random.chance(0.3) ? `090-0000-${pad(n, 4)}` : null,
      fax: hasFax ? fictionalPhone("01", n) : null,
      email,
      lineId: random.chance(0.1) ? `sample_line_${pad(n, 4)}` : null,
      mainContact: email ? "email" : hasFax ? "fax" : "phone",
      deliveryDays: isCustomer ? random.pick([0, 0, 1, 1, 1, 2] as const) : 0,
      defaultSendMethod: email && random.chance(0.75) ? "email" : "none",
      mailOrderAllowed: random.chance(0.3),
      placeName: `架空県見本市${PLACE_WORDS[n % PLACE_WORDS.length] ?? ""}`,
      registrationNumber: individual || random.chance(0.15) ? null : `T0000000${pad(n, 6)}`,
      terms,
    });
  }
  return out;
}

// ---- 商品 ---------------------------------------------------------------------

type Zone = "ambient" | "chilled" | "frozen";

interface ProductBase {
  readonly name: string;
  readonly zone?: Zone;
  readonly salesUnit: string;
  readonly purchaseUnit: string;
  readonly perCase: readonly number[];
  /** 卸単価の範囲（円、販売単位あたり） */
  readonly price: readonly [number, number];
  readonly packs: readonly string[];
  readonly variants: readonly string[];
}

interface GenreSpec {
  readonly name: string;
  readonly taxCategory: "standard" | "reduced";
  readonly zone: Zone;
  readonly products: readonly ProductBase[];
}

const box = (name: string, price: [number, number], variants: string[], packs: string[]) => ({
  name,
  salesUnit: "箱",
  purchaseUnit: "ケース",
  perCase: [6, 10, 12, 20],
  price,
  packs,
  variants,
});

/** ジャンルと商品のもと。税区分は食品が軽減税率、酒類・雑貨は標準税率 */
export const GENRES: readonly GenreSpec[] = [
  {
    name: "和菓子",
    taxCategory: "reduced",
    zone: "ambient",
    products: [
      box("羊羹", [300, 1500], ["小倉", "栗", "抹茶", "塩"], ["1本", "ミニ5本入"]),
      box("どら焼き", [150, 1200], ["粒あん", "栗", "生クリーム"], ["1個", "5個入"]),
      box("最中", [120, 1000], ["つぶあん", "ごま"], ["1個", "8個入"]),
      { ...box("大福", [150, 900], ["豆", "よもぎ", "いちご"], ["1個", "6個入"]), zone: "chilled" },
      box("まんじゅう", [100, 1200], ["酒", "黒糖", "栗"], ["1個", "10個入"]),
      box("かりんとう", [200, 600], ["黒糖", "白", "ごま"], ["120g", "250g"]),
    ],
  },
  {
    name: "洋菓子",
    taxCategory: "reduced",
    zone: "chilled",
    products: [
      box("チーズケーキ", [400, 2500], ["ベイクド", "レア"], ["1個", "ホール"]),
      box("ロールケーキ", [600, 1800], ["プレーン", "抹茶", "いちご"], ["1本", "ハーフ"]),
      box("プリン", [200, 400], ["カスタード", "焼き", "抹茶"], ["1個", "4個入"]),
      box("シュークリーム", [150, 300], ["カスタード", "生クリーム"], ["1個"]),
    ],
  },
  {
    name: "焼き菓子",
    taxCategory: "reduced",
    zone: "ambient",
    products: [
      box("クッキー", [300, 2000], ["バター", "ココア", "アーモンド"], ["12枚入", "24枚入"]),
      box("マドレーヌ", [120, 1500], ["プレーン", "レモン"], ["1個", "10個入"]),
      box("フィナンシェ", [150, 1800], ["プレーン", "抹茶"], ["1個", "8個入"]),
      box("バームクーヘン", [500, 2500], ["プレーン", "チョコ"], ["1個", "大"]),
      box("カステラ", [600, 2400], ["プレーン", "抹茶", "黒糖"], ["0.5号", "1号"]),
    ],
  },
  {
    name: "米菓",
    taxCategory: "reduced",
    zone: "ambient",
    products: [
      {
        name: "せんべい",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [10, 20, 30],
        price: [200, 900],
        packs: ["10枚入", "20枚入"],
        variants: ["醤油", "ごま", "海苔", "ざらめ"],
      },
      {
        name: "おかき",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [10, 20],
        price: [250, 800],
        packs: ["120g", "200g"],
        variants: ["塩", "醤油", "えび"],
      },
      {
        name: "あられ",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [20, 30],
        price: [150, 500],
        packs: ["80g", "150g"],
        variants: ["五色", "醤油"],
      },
    ],
  },
  {
    name: "飲料",
    taxCategory: "reduced",
    zone: "ambient",
    products: [
      {
        name: "緑茶",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [24],
        price: [90, 160],
        packs: ["500ml", "2L"],
        variants: ["煎茶", "ほうじ茶"],
      },
      {
        name: "缶コーヒー",
        salesUnit: "缶",
        purchaseUnit: "ケース",
        perCase: [24, 30],
        price: [80, 140],
        packs: ["190g", "280ml"],
        variants: ["微糖", "ブラック", "カフェオレ"],
      },
      {
        name: "りんごジュース",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [12, 24],
        price: [150, 500],
        packs: ["200ml", "1L"],
        variants: ["ストレート", "すりおろし"],
      },
      {
        name: "サイダー",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [24],
        price: [100, 200],
        packs: ["240ml", "500ml"],
        variants: ["レモン", "りんご", "定番"],
      },
    ],
  },
  {
    name: "酒類",
    taxCategory: "standard",
    zone: "ambient",
    products: [
      {
        name: "日本酒",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [6, 12],
        price: [900, 4500],
        packs: ["300ml", "720ml", "1.8L"],
        variants: ["純米", "吟醸", "本醸造"],
      },
      {
        name: "地ビール",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [12, 24],
        price: [300, 700],
        packs: ["330ml", "500ml"],
        variants: ["ペールエール", "ヴァイツェン", "スタウト"],
      },
      {
        name: "梅酒",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [6, 12],
        price: [800, 3000],
        packs: ["500ml", "720ml"],
        variants: ["定番", "はちみつ"],
      },
    ],
  },
  {
    name: "水産加工品",
    taxCategory: "reduced",
    zone: "chilled",
    products: [
      {
        name: "塩辛",
        salesUnit: "個",
        purchaseUnit: "ケース",
        perCase: [10, 20],
        price: [300, 900],
        packs: ["120g", "200g"],
        variants: ["いか", "ゆず", "わた"],
      },
      {
        name: "ほたて燻製",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [10, 20],
        price: [500, 1500],
        packs: ["50g", "100g"],
        variants: ["プレーン", "黒こしょう"],
      },
      {
        name: "わかめ",
        zone: "ambient",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [20, 30],
        price: [200, 800],
        packs: ["30g", "100g"],
        variants: ["湯通し塩蔵", "乾燥", "茎"],
      },
      {
        name: "焼きうに",
        zone: "frozen",
        salesUnit: "個",
        purchaseUnit: "ケース",
        perCase: [6, 10],
        price: [1200, 4000],
        packs: ["60g", "100g"],
        variants: ["定番"],
      },
    ],
  },
  {
    name: "冷凍食品",
    taxCategory: "reduced",
    zone: "frozen",
    products: [
      {
        name: "冷凍ほたて",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [10],
        price: [800, 3000],
        packs: ["300g", "1kg"],
        variants: ["玉冷", "ボイル"],
      },
      {
        name: "アイスクリーム",
        salesUnit: "個",
        purchaseUnit: "ケース",
        perCase: [24, 36],
        price: [150, 400],
        packs: ["120ml"],
        variants: ["バニラ", "抹茶", "ずんだ", "塩"],
      },
      {
        name: "冷凍たい焼き",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [10, 20],
        price: [400, 900],
        packs: ["5個入", "10個入"],
        variants: ["あずき", "カスタード"],
      },
    ],
  },
  {
    name: "調味料",
    taxCategory: "reduced",
    zone: "ambient",
    products: [
      {
        name: "醤油",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [12, 20],
        price: [250, 900],
        packs: ["500ml", "1L"],
        variants: ["濃口", "薄口", "だし"],
      },
      {
        name: "味噌",
        salesUnit: "個",
        purchaseUnit: "ケース",
        perCase: [10, 20],
        price: [400, 1200],
        packs: ["500g", "1kg"],
        variants: ["米", "麦", "合わせ"],
      },
      {
        name: "めんつゆ",
        salesUnit: "本",
        purchaseUnit: "ケース",
        perCase: [12],
        price: [300, 700],
        packs: ["500ml", "1L"],
        variants: ["3倍濃縮", "ストレート"],
      },
    ],
  },
  {
    name: "麺類",
    taxCategory: "reduced",
    zone: "ambient",
    products: [
      {
        name: "そば",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [20, 30],
        price: [200, 600],
        packs: ["200g", "2人前"],
        variants: ["十割", "二八", "茶そば"],
      },
      {
        name: "ラーメン",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [20, 30],
        price: [250, 700],
        packs: ["2食入", "4食入"],
        variants: ["醤油", "塩", "味噌"],
      },
      {
        name: "うどん",
        salesUnit: "袋",
        purchaseUnit: "ケース",
        perCase: [20],
        price: [200, 500],
        packs: ["250g", "3人前"],
        variants: ["細切り", "太切り"],
      },
    ],
  },
  {
    name: "雑貨",
    taxCategory: "standard",
    zone: "ambient",
    products: [
      {
        name: "手ぬぐい",
        salesUnit: "枚",
        purchaseUnit: "箱",
        perCase: [10, 20],
        price: [500, 1500],
        packs: ["1枚"],
        variants: ["かもめ柄", "波柄", "桜柄"],
      },
      {
        name: "紙袋",
        salesUnit: "枚",
        purchaseUnit: "束",
        perCase: [50, 100],
        price: [10, 60],
        packs: ["小", "中", "大"],
        variants: ["白", "茶"],
      },
      {
        name: "保冷バッグ",
        salesUnit: "個",
        purchaseUnit: "箱",
        perCase: [20, 50],
        price: [80, 300],
        packs: ["S", "M", "L"],
        variants: ["銀", "白"],
      },
      {
        name: "ギフト箱",
        salesUnit: "個",
        purchaseUnit: "箱",
        perCase: [20, 50],
        price: [50, 250],
        packs: ["2本用", "4個用", "6個用"],
        variants: ["白", "金"],
      },
    ],
  },
];

export interface ItemSpec {
  readonly index: number;
  readonly name: string;
  readonly genre: string;
  readonly supplierIndex: number;
  readonly temperatureZone: Zone;
  readonly taxCategory: "standard" | "reduced";
  readonly purchaseUnitName: string;
  readonly salesUnitName: string;
  readonly unitsPerPurchaseUnit: number;
  readonly purchasePriceCenti: number;
  readonly salesPriceCenti: number;
  readonly purchaseMinLot: number;
  readonly salesMinLot: number;
  readonly leadTimeDays: number;
  readonly jan: string | null;
  readonly inputPriceOnOrder: boolean;
  readonly memo: string | null;
}

/** JAN（店内用の 2 で始まる13桁。チェックディジットつき） */
export function fictionalJan(n: number): string {
  const body = `29${pad(n, 10)}`;
  const digits = Array.from(body, Number);
  let sum = 0;
  digits.toReversed().forEach((d, i) => {
    sum += i % 2 === 0 ? d * 3 : d;
  });
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** 仕入先の業種に合うジャンル */
function genresFor(supplierName: string): readonly GenreSpec[] {
  const match = (names: readonly string[]) => GENRES.filter((g) => names.includes(g.name));
  if (supplierName.includes("水産")) return match(["水産加工品"]);
  if (supplierName.includes("酒造")) return match(["酒類"]);
  if (supplierName.includes("冷凍")) return match(["冷凍食品"]);
  if (supplierName.includes("包装") || supplierName.includes("工芸")) return match(["雑貨"]);
  if (supplierName.includes("製麺")) return match(["麺類"]);
  if (supplierName.includes("珈琲") || supplierName.includes("茶園")) return match(["飲料"]);
  if (supplierName.includes("醸造")) return match(["調味料"]);
  if (supplierName.includes("牧場")) return match(["洋菓子", "冷凍食品"]);
  if (supplierName.includes("菓子舗")) return match(["和菓子", "米菓"]);
  if (supplierName.includes("製菓") || supplierName.includes("製パン"))
    return match(["洋菓子", "焼き菓子", "和菓子"]);
  return GENRES;
}

/**
 * 商品の一覧。仕入先ごとに業種に合うジャンルの商品を持たせる（大きい仕入先ほど商品が多い）。
 * suppliers は仕入先（仕入先だけ・両方）の取引先の作る順の番号。
 */
export function itemSpecs(
  random: Random,
  count: number,
  suppliers: readonly { index: number; name: string }[],
): ItemSpec[] {
  // 仕入先ごとの重み（少数の仕入先が多くの商品を持つ）
  const weights = suppliers.map((s, i) => ({ s, w: 1 / (1 + (i % 37)) + random.next() * 0.3 }));
  const out: ItemSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    // 仕入先がどれも1つは商品を持つように、最初は順に割り当てる
    const supplier =
      index < suppliers.length ? suppliers[index] : random.weighted(weights, (x) => x.w).s;
    if (!supplier) break;
    const genre = random.pick(genresFor(supplier.name));
    const product = random.pick(genre.products);
    const variant = random.pick(product.variants);
    const pack = random.pick(product.packs);
    const place = supplier.name.match(/(サンプル|見本|テスト|架空)([ぁ-ん]+)/)?.[2] ?? "みほん";
    const units = random.pick(product.perCase);
    const salesYen = random.int(product.price[0], product.price[1]);
    // 卸単価は10円単位にそろえ、仕入価格（仕入単位）は小数第2位までの端数を持たせる
    const salesPriceCenti = Math.round(salesYen / 10) * 10 * 100;
    const purchasePriceCenti = Math.round(salesPriceCenti * units * (0.55 + random.next() * 0.2));
    const salesMinLot = random.chance(0.15) ? random.pick([3, 6, 10] as const) : 1;
    out.push({
      index,
      name: `${place}${product.name} ${variant} ${pack}`,
      genre: genre.name,
      supplierIndex: supplier.index,
      temperatureZone: product.zone ?? genre.zone,
      taxCategory: genre.taxCategory,
      purchaseUnitName: product.purchaseUnit,
      salesUnitName: product.salesUnit,
      unitsPerPurchaseUnit: units,
      purchasePriceCenti,
      salesPriceCenti,
      purchaseMinLot: random.chance(0.2) ? random.pick([2, 3, 5] as const) : 1,
      salesMinLot,
      leadTimeDays: random.pick([1, 2, 2, 3, 3, 4, 5, 7] as const),
      jan: random.chance(0.75) ? fictionalJan(index + 1) : null,
      inputPriceOnOrder: random.chance(0.03),
      memo: random.chance(0.05) ? "賞味期限の短い商品。先入れ先出しを徹底する" : null,
    });
  }
  return out;
}

// ---- 社員・保管場所・店舗 -----------------------------------------------------------

export const SEED_EMPLOYEES = [
  { key: "purchasing1", name: "仕入 一郎", roles: ["purchasing"] },
  { key: "purchasing2", name: "仕入 二子", roles: ["purchasing"] },
  { key: "sales1", name: "受注 三郎", roles: ["sales"] },
  { key: "sales2", name: "受注 四子", roles: ["sales"] },
  { key: "warehouse1", name: "倉庫 五郎", roles: ["sales"] },
  { key: "accounting1", name: "経理 六子", roles: ["accounting"] },
  { key: "accounting2", name: "経理 七郎", roles: ["accounting"] },
  { key: "multi1", name: "兼任 八子", roles: ["purchasing", "sales"] },
  { key: "manager1", name: "管理 九郎", roles: ["admin"] },
  // 途中で退職して無効になる社員（過去の取引の担当者名は残る）
  { key: "retired1", name: "退職 十子", roles: ["sales"] },
] as const;

export type SeedEmployeeKey = (typeof SEED_EMPLOYEES)[number]["key"];

export function employeeEmail(key: SeedEmployeeKey): string {
  return `${key}@example.co.jp`;
}

export const SEED_LOCATIONS = [
  { key: "main", name: "本社倉庫", displayOrder: 1, n: 9001 },
  { key: "cold", name: "冷蔵倉庫", displayOrder: 2, n: 9002 },
  { key: "second", name: "第二倉庫", displayOrder: 3, n: 9003 },
] as const;

export type SeedLocationKey = (typeof SEED_LOCATIONS)[number]["key"];

export const SEED_STORES = ["本店", "駅前店", "物産館店"] as const;

export const SEED_COMPANY = {
  name: "株式会社サンプル流通",
  registrationNumber: "T0000000000001",
  postalCode: "0000001",
  address: "架空県見本市みなと町1-2-3",
  phone: "0192-00-0001",
  fax: "0192-01-0001",
  email: "info@example.co.jp",
  bankInfo: "見本銀行 サンプル支店 普通 0000000 カ）サンプルリュウツウ",
} as const;
