/**
 * 语音作答的文本理解层：把浏览器识别出的一句话，映射成量表里的一个选项或一个数值。
 *
 * 为什么单独一层：`SpeechRecognition` 只给文字，不给语义。老人说「有一点」
 * 而选项写「轻度」，说「二十分钟」而选项写「0~30 分钟」——这些对应关系
 * 必须由我们决定，而且每个判断都有临床后果，所以全部做成纯函数，
 * 用单测逐条锁住，不在组件里散落 `if`。
 *
 * 保守原则：拿不准就不选。宁可提示老人「请再说一次或直接点选项」，
 * 也不能把「说不清」猜成一个有分值的答案。
 */

import type { ScaleOption } from "./types";

/* ------------------------------------------------------------------ */
/* 一、文本归一化                                                       */
/* ------------------------------------------------------------------ */

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};

const CN_UNIT: Record<string, number> = {
  十: 10,
  拾: 10,
  百: 100,
  佰: 100,
  千: 1000,
  仟: 1000,
};

/** 中文数字连续串（含小数点「点」） */
const CN_NUMERAL_RUN = /[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万点]+/g;

/** 含「一」却不是数字的日常词：先剔除，否则「一直」会被读成 1 */
const NOISE_PHRASES = [
  "一点点",
  "一点",
  "有点儿",
  "有点",
  "一些",
  "一下",
  "一直",
  "一样",
  "一起",
  "一定",
  "一共",
  "一般",
  "一块",
  "几乎",
];

/**
 * 归一化：全角转半角、去标点与空白、转小写。
 *
 * `NFKC` 负责把「３」「，」「？」这些全角字符折回 ASCII；中文本身的标点
 * （、。；）NFKC 不管，单独删。小数点只在数字之间保留，否则句末的「。」
 * 会让「没有。」和「没有」对不上。
 */
export function normalizeVoiceText(input: string): string {
  if (!input) return "";
  let text = input.normalize("NFKC").toLowerCase();
  text = text.replace(/[。、，；：？！…·,;:!?]/g, "");
  text = text.replace(/["'“”‘’「」『』《》〈〉()（）[\]【】{}]/g, "");
  text = text.replace(/[—–\-_/\\|~～]/g, "");
  text = text.replace(/\.(?!\d)/g, "");
  return text.replace(/\s+/g, "");
}

/**
 * 去掉不承载意义的功能词，用于「说的是同一句话，只是多了个『的时候』」。
 *
 * 只删虚词，不删「不」「没」这类否定词——那会把意思改掉。
 * 只在两侧都还剩 3 个字以上时启用，避免「是的」被削成「是」后误命中。
 */
const FUNCTION_WORDS = /(的|了|在|和|与|及|以及|时候|时|然后|就|也|都|吧|呢|啊|呀|嘛)/g;

function stripFunctionWords(text: string): string {
  return text.replace(FUNCTION_WORDS, "");
}

/* ------------------------------------------------------------------ */
/* 二、中文数字                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把中文数字串转成数值；无法识别返回 null。
 *
 * 支持「十五」「二十」「一百零五」「两千三百」「三点五」，也直接接受阿拉伯数字。
 * 不做「三两」「一个半」这类模糊表达。
 */
export function chineseToNumber(raw: string): number | null {
  const text = (raw ?? "").replace(/\s/g, "");
  if (!text) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);

  if (text.includes("点")) {
    const [intPart, decPart] = text.split("点");
    if (!decPart) return null;
    const intValue = intPart ? chineseToNumber(intPart) : 0;
    if (intValue === null) return null;
    let decimals = "";
    for (const char of decPart) {
      const digit = CN_DIGIT[char];
      if (digit === undefined) return null;
      decimals += String(digit);
    }
    return Number(`${intValue}.${decimals}`);
  }

  let total = 0;
  let section = 0;
  let pending = 0;
  let seen = false;
  for (const char of text) {
    if (CN_DIGIT[char] !== undefined) {
      pending = CN_DIGIT[char];
      seen = true;
      continue;
    }
    const unit = CN_UNIT[char];
    if (unit !== undefined) {
      // 「十五」开头的「十」前面没有数字，按 1 个十算
      section += (pending === 0 ? 1 : pending) * unit;
      pending = 0;
      seen = true;
      continue;
    }
    if (char === "万") {
      total += (section + pending) * 10000;
      section = 0;
      pending = 0;
      seen = true;
      continue;
    }
    return null;
  }
  return seen ? total + section + pending : null;
}

/** 把文本里的中文数字串统一换成阿拉伯数字，便于和标签做同形比较 */
export function toArabicDigits(text: string): string {
  return text.replace(CN_NUMERAL_RUN, (run) => {
    const value = chineseToNumber(run);
    return value === null ? run : String(value);
  });
}

/**
 * 「4 分：面部扭曲」「2 级」这类以分值／等级开头的标签，用说出的数字直接对上。
 *
 * 疼痛行为、洼田饮水这些量表的分档选项长这样，直接说「四分」比说「第 4 个」自然。
 */
function matchNumberedLabel<T extends { label: string }>(
  value: number,
  options: T[],
): T | null {
  const hits = options.filter((option) => {
    const text = option.label.replace(/\s/g, "");
    const match = text.match(/^(\d+(?:\.\d+)?)(分|级|度|期)/);
    return match ? Number(match[1]) === value : false;
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 从一句话里取出数值（实测项、时间区间题用）。
 *
 * 先剔除「一点」「一直」等口语词——老人说「有一点没劲」时不能填成 1。
 */
export function extractVoiceNumber(text: string): number | null {
  let norm = normalizeVoiceText(text);
  if (!norm) return null;

  for (const phrase of NOISE_PHRASES) {
    norm = norm.split(phrase).join("");
  }
  if (!norm) return null;

  const arabic = norm.match(/\d+(?:\.\d+)?/);
  if (arabic) return Number(arabic[0]);

  const runs = norm.match(CN_NUMERAL_RUN);
  if (!runs) return null;
  // 长串优先：「一百二十」要整体解析，不能先被「一」截走
  const byLength = [...runs].sort((a, b) => b.length - a.length);
  for (const run of byLength) {
    const value = chineseToNumber(run);
    if (value !== null) return value;
  }
  return null;
}

/** 取出数值后面的单位（分钟/小时/次/秒/米/厘米/天），用于区间题核对 */
export function extractVoiceUnit(text: string): string {
  const norm = normalizeVoiceText(text);
  const match = norm.match(/(分钟|小时|秒钟|秒|厘米|公分|米|次|天|周|月|年|分)/);
  if (!match) return "";
  const unit = match[1];
  // 「分」在「十分钟」之外几乎不单独出现，统一归到分钟
  if (unit === "分") return "分钟";
  if (unit === "秒钟") return "秒";
  if (unit === "公分") return "厘米";
  return unit;
}

/* ------------------------------------------------------------------ */
/* 三、序数                                                             */
/* ------------------------------------------------------------------ */

/** 「第一个」「第 2 项」「选三」里的序号（从 1 开始）；没有则 null */
export function parseVoiceOrdinal(text: string): number | null {
  const norm = normalizeVoiceText(text);
  if (!norm) return null;
  const match = norm.match(/第([零〇一二两三四五六七八九十百\d]+)(?:个|项|条|种|题|档|选项)?/);
  if (!match) return null;
  const value = chineseToNumber(match[1]);
  return value !== null && value >= 1 ? value : null;
}

/* ------------------------------------------------------------------ */
/* 四、区间选项（「0~30 分钟」「超过 6 小时」）                          */
/* ------------------------------------------------------------------ */

interface VoiceRange {
  min: number;
  max: number;
  unit: string;
}

function parseLabelRange(label: string): VoiceRange | null {
  const text = (label ?? "").replace(/\s/g, "");
  if (!text) return null;

  // 「不超过 / 少于 / 小于 / 低于 / 不足」必须先于「超过」判断，
  // 否则「不超过 1 次」会被当成「超过 1 次」
  let match = text.match(/(?:不超过|少于|小于|低于|不足)(\d+(?:\.\d+)?)(.*)$/);
  if (match) {
    return { min: Number.NEGATIVE_INFINITY, max: Number(match[1]), unit: match[2] };
  }
  match = text.match(/(?:超过|大于|多于|高于)(\d+(?:\.\d+)?)(.*)$/);
  if (match) {
    return { min: Number(match[1]), max: Number.POSITIVE_INFINITY, unit: match[2] };
  }
  // 「每周 2~3 次」前面带限定词，不能要求从行首开始
  match = text.match(/(\d+(?:\.\d+)?)[~～\-—–至到](\d+(?:\.\d+)?)(.*)$/);
  if (match) {
    return { min: Number(match[1]), max: Number(match[2]), unit: match[3] };
  }
  match = text.match(/^(\d+(?:\.\d+)?)(\D.*)$/);
  if (match) {
    return { min: Number(match[1]), max: Number(match[1]), unit: match[2] };
  }
  return null;
}

function unitCompatible(labelUnit: string, saidUnit: string): boolean {
  const clean = (value: string) => value.replace(/[^\u4e00-\u9fa5]/g, "");
  const left = clean(labelUnit);
  const right = clean(saidUnit);
  // 老人只说「二十」不说单位时不能排除，交给区间唯一性兜底
  if (!left || !right) return true;
  return left.includes(right) || right.includes(left);
}

/** 说出「二十分钟」→ 命中「0~30 分钟」；多区间同时命中视为歧义，不选 */
function matchVoiceRange<T extends { label: string }>(text: string, options: T[]): T | null {
  const value = extractVoiceNumber(text);
  if (value === null) return null;
  const unit = extractVoiceUnit(text);
  const hits = options.filter((option) => {
    const range = parseLabelRange(option.label);
    if (!range) return false;
    if (value < range.min || value > range.max) return false;
    return unitCompatible(range.unit, unit);
  });
  return hits.length === 1 ? hits[0] : null;
}

/* ------------------------------------------------------------------ */
/* 五、口语同义词                                                       */
/* ------------------------------------------------------------------ */

/**
 * 老人不会照着选项念。这里收的是「说这句话的人想选哪一档」，
 * 命中后仍要求整题只有一个选项对上，避免把「不能」硬塞给「不受限」。
 *
 * 匹配方式：标签完全等于口头词 → 标签以它开头（「是（插管…）」对「是」）
 * → 长词被标签包含（「需部分帮助」里的「部分帮助」）。
 */
const SYNONYM_GROUPS: { said: string[]; labels: string[] }[] = [
  {
    said: ["是", "是的", "有", "会", "能", "可以", "对", "嗯", "有的", "一直是"],
    labels: ["是", "有", "会", "能", "可以", "可", "对"],
  },
  {
    said: ["否", "没有", "没", "无", "不", "不会", "不能", "不是", "从不", "并没有"],
    labels: ["否", "没有", "没", "无", "从不", "不是"],
  },
  {
    said: ["轻度", "轻微", "有一点", "有点", "一点", "稍微", "一个"],
    labels: ["轻度", "轻微", "少量", "偶尔"],
  },
  {
    said: ["中度", "中等", "一般", "还行", "有些"],
    labels: ["中度", "中等量", "有时"],
  },
  {
    said: ["重度", "严重", "很严重", "厉害", "大量", "总是", "经常"],
    labels: ["重度", "大量", "一直", "经常"],
  },
  {
    // 帮助程度：ADL/IADL 量表里最常被口语化的一档
    said: ["需要帮忙", "要人帮", "帮一点", "帮点忙", "帮一下", "需要帮助", "帮帮忙"],
    labels: ["部分帮助"],
  },
  {
    said: ["全靠别人", "完全靠人", "都靠别人", "完全依赖", "做不了", "帮不上"],
    labels: ["极大帮助", "完全依赖"],
  },
];

/** 「不知道」不是「否」：这类回答必须停下来问清楚，不能算成阴性 */
const UNSURE_PHRASES = [
  "不知道",
  "不清楚",
  "不确定",
  "说不清",
  "说不好",
  "不好说",
  "忘了",
  "忘记",
  "记不清",
  "记不得",
  "不一定",
  "没想过",
];

/** 去掉「我觉得」「我自己」这类开场词，让同义词能从头匹配 */
const FILLER_PREFIX =
  /^(?:嗯|哦|呃|唉|那个|这个|就是|应该|好像|估计|我觉得|我感觉|我看|我自己|我|咱们|我们)+/;

function stripFillers(norm: string): string {
  return norm.replace(FILLER_PREFIX, "");
}

/** 老人表达了「不确定」——此时返回 true，调用方应放弃自动选择 */
export function isUnsureAnswer(text: string): boolean {
  const norm = stripFillers(normalizeVoiceText(text));
  return UNSURE_PHRASES.some((phrase) => norm.includes(phrase));
}

function matchBySynonym<T extends { label: string }>(norm: string, options: T[]): T | null {
  const core = stripFillers(norm);
  if (!core) return null;

  // 命中多个组时取最长的口头词：「有一点」胜过「有」
  let group: (typeof SYNONYM_GROUPS)[number] | null = null;
  let saidLength = 0;
  SYNONYM_GROUPS.forEach((item) => {
    item.said.forEach((word) => {
      if (core.startsWith(word) && word.length > saidLength) {
        group = item;
        saidLength = word.length;
      }
    });
  });
  if (!group) return null;

  const hits = options.filter((option) => {
    const label = toArabicDigits(normalizeVoiceText(option.label));
    return group!.labels.some(
      (word) =>
        label === word ||
        label.startsWith(word) ||
        // 单字标签不做包含，否则「不」会命中「不受限」
        (word.length >= 2 && label.includes(word)),
    );
  });
  return hits.length === 1 ? hits[0] : null;
}

/* ------------------------------------------------------------------ */
/* 六、对外匹配                                                         */
/* ------------------------------------------------------------------ */

/** 命中的依据层级，仅用于调试与单测断言，不展示给老人 */
export type VoiceMatchTier =
  | "ordinal"
  | "exact"
  | "contains"
  | "number_label"
  | "range"
  | "synonym"
  | "core"
  | "index";

export interface VoiceMatch<T> {
  option: T;
  index: number;
  /** high：老人明确说出选项或序号；low：靠口语推断，界面应提示确认 */
  confidence: "high" | "low";
  tier: VoiceMatchTier;
}

function asMatch<T extends { label: string }>(
  option: T,
  index: number,
  confidence: "high" | "low",
  tier: VoiceMatchTier,
): VoiceMatch<T> {
  return { option, index, confidence, tier };
}

/**
 * 单选题：一句话 → 一个选项（拿不准返回 null）。
 *
 * 判定顺序即「可信度从高到低」：显式序号 → 选项原文 → 句中包含选项 →
 * 区间 → 口语同义词 → 去否定词后的核心词 → 纯数字按位置。
 */
export function matchVoiceOption<T extends { label: string }>(
  transcript: string,
  options: T[],
): VoiceMatch<T> | null {
  const list = options ?? [];
  if (!list.length) return null;
  const norm = toArabicDigits(normalizeVoiceText(transcript));
  if (!norm) return null;

  // 1. 「第 2 个」——最明确
  const ordinal = parseVoiceOrdinal(transcript);
  if (ordinal !== null && ordinal <= list.length) {
    return asMatch(list[ordinal - 1], ordinal - 1, "high", "ordinal");
  }

  // 2. 整句就是选项原文（「3 分」对「三分」「没有」对「没有」）
  const exactIndex = list.findIndex(
    (option) => toArabicDigits(normalizeVoiceText(option.label)) === norm,
  );
  if (exactIndex >= 0) {
    return asMatch(list[exactIndex], exactIndex, "high", "exact");
  }

  // 3. 说的是同一句话，只是多了「的时候」这类虚词
  const boiled = stripFunctionWords(norm);
  if (boiled.length >= 3) {
    const sameIndex = list.findIndex((option) => {
      const label = stripFunctionWords(toArabicDigits(normalizeVoiceText(option.label)));
      return label.length >= 3 && label === boiled;
    });
    if (sameIndex >= 0) {
      return asMatch(list[sameIndex], sameIndex, "high", "exact");
    }
  }

  // 4. 说了一整句，里面带着选项原文；取最长的那条（「完全依赖」优于「依赖」）
  const contained = list
    .map((option, index) => ({
      option,
      index,
      label: toArabicDigits(normalizeVoiceText(option.label)),
    }))
    .filter((item) => item.label.length >= 2 && norm.includes(item.label))
    .sort((a, b) => b.label.length - a.label.length);
  if (contained.length) {
    const [best, second] = contained;
    if (!second || second.label.length < best.label.length) {
      return asMatch(best.option, best.index, "high", "contains");
    }
  }

  // 4. 分值型标签（「四分」→「4 分：面部扭曲」）
  const spokenNumber = extractVoiceNumber(transcript);
  if (spokenNumber !== null) {
    const numbered = matchNumberedLabel(spokenNumber, list);
    if (numbered) {
      return asMatch(numbered, list.indexOf(numbered), "high", "number_label");
    }
  }

  // 5. 数值区间（「二十分钟」→「0~30 分钟」）
  const range = matchVoiceRange(transcript, list);
  if (range) {
    return asMatch(range, list.indexOf(range), "high", "range");
  }

  // 6. 口语同义词（「有」→「是」，「没有」→「否」）。
  //    注意「不知道」不是「否」——题库里确实有「不知道下降多少」这样的选项，
  //    所以这条守卫放在选项原文匹配之后、猜同义词之前。
  if (isUnsureAnswer(transcript)) return null;
  const synonym = matchBySynonym(norm, list);
  if (synonym) {
    return asMatch(synonym, list.indexOf(synonym), "low", "synonym");
  }

  // 7. 「没有漏尿」去掉存在否定后剩「漏尿」，恰好只有一个选项含它。
  //    只剥「没有/没」：把「不能」剥成「能」会把意思反过来。
  const core = norm.replace(/^(?:也|都|并|就)?(?:没有|没)/, "");
  if (core.length >= 2 && core !== norm) {
    const hits = list
      .map((option, index) => ({ option, index }))
      .filter((item) => toArabicDigits(normalizeVoiceText(item.option.label)).includes(core));
    if (hits.length === 1) {
      return asMatch(hits[0].option, hits[0].index, "low", "core");
    }
  }

  // 8. 只说了个数字：按第几个处理（分值型选项在第 4 步就已命中，走不到这里）
  if (/^\d+$/.test(norm)) {
    const position = Number(norm);
    if (position >= 1 && position <= list.length) {
      return asMatch(list[position - 1], position - 1, "low", "index");
    }
  }

  return null;
}

/**
 * 多选题：一句话可能报好几项（「能自己吃饭、洗澡不行」）。
 *
 * 先按并列词切开逐段匹配；切不动时退回「整句里包含哪些选项」。只看高置信度
 * 结果，避免多选题一口气吞进一堆模糊选项。
 */
export function matchVoiceOptions<T extends { label: string }>(
  transcript: string,
  options: T[],
): VoiceMatch<T>[] {
  const list = options ?? [];
  if (!list.length) return [];
  const raw = (transcript ?? "").trim();
  if (!raw) return [];

  const picked: VoiceMatch<T>[] = [];
  const push = (match: VoiceMatch<T> | null) => {
    if (!match) return;
    if (match.confidence !== "high") return;
    if (picked.some((item) => item.index === match.index)) return;
    picked.push(match);
  };

  const segments = raw
    .split(/[和、，,；;]|还有|以及|跟|与/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (segments.length > 1) {
    segments.forEach((segment) => push(matchVoiceOption(segment, list)));
    if (picked.length) return picked.sort((a, b) => a.index - b.index);
  }

  // 整句扫描：所有「原文出现在句子里」的选项
  const norm = toArabicDigits(normalizeVoiceText(raw));
  list.forEach((option, index) => {
    const label = toArabicDigits(normalizeVoiceText(option.label));
    if (label.length >= 2 && norm.includes(label)) {
      push(asMatch(option, index, "high", "contains"));
    }
  });
  if (picked.length) return picked.sort((a, b) => a.index - b.index);

  // 最后再试一次整句单选（「都没有」这类）
  push(matchVoiceOption(raw, list));
  return picked.sort((a, b) => a.index - b.index);
}

/** 便捷判断：这道题能不能用语音选（有选项就能选） */
export function canAnswerByVoice(question: {
  input_type?: string;
  options?: ScaleOption[];
}): boolean {
  if (question.input_type === "number") return true;
  return Boolean(question.options && question.options.length > 0);
}
