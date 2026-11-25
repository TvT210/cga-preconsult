import { describe, expect, it } from "vitest";

import {
  canAnswerByVoice,
  chineseToNumber,
  extractVoiceNumber,
  extractVoiceUnit,
  matchVoiceOption,
  matchVoiceOptions,
  normalizeVoiceText,
  parseVoiceOrdinal,
  toArabicDigits,
} from "./voiceAnswer";

/** 真实题库里出现过的选项组合，直接拿来当夹具 */
const YES_NO = [{ value: "1", label: "是" }, { value: "0", label: "否" }];
const SEVERITY = [
  { value: "mild", label: "轻度" },
  { value: "moderate", label: "中度" },
  { value: "severe", label: "重度" },
];
const TIME_BANDS = [
  { value: "a", label: "0~30 分钟" },
  { value: "b", label: "31~60 分钟" },
  { value: "c", label: "61~120 分钟" },
  { value: "d", label: "超过 120 分钟" },
];
const ADL_HELP = [
  { value: "0", label: "完全依赖" },
  { value: "5", label: "需部分帮助" },
  { value: "10", label: "需极大帮助或完全依赖" },
];

describe("文本归一化", () => {
  it("全角数字与标点折成半角，空白全部去掉", () => {
    expect(normalizeVoiceText("　３ 分，。")).toBe("3分");
  });

  it("小数点保留，句末句号丢弃", () => {
    expect(normalizeVoiceText("3.5 秒。")).toBe("3.5秒");
    expect(normalizeVoiceText("没有。")).toBe("没有");
  });

  it("引号书名号括号不影响比对", () => {
    expect(normalizeVoiceText("选「轻度」")).toBe("选轻度");
  });

  it("空串与纯空白返回空串", () => {
    expect(normalizeVoiceText("")).toBe("");
    expect(normalizeVoiceText("   ")).toBe("");
  });
});

describe("中文数字解析", () => {
  it("个位数与十位", () => {
    expect(chineseToNumber("三")).toBe(3);
    expect(chineseToNumber("十")).toBe(10);
    expect(chineseToNumber("十五")).toBe(15);
    expect(chineseToNumber("二十")).toBe(20);
  });

  it("百位与零", () => {
    expect(chineseToNumber("一百零五")).toBe(105);
    expect(chineseToNumber("两百三十")).toBe(230);
    expect(chineseToNumber("一百二十")).toBe(120);
  });

  it("千位与小数", () => {
    expect(chineseToNumber("两千三百")).toBe(2300);
    expect(chineseToNumber("三点五")).toBe(3.5);
  });

  it("阿拉伯数字原样返回", () => {
    expect(chineseToNumber("3.5")).toBe(3.5);
    expect(chineseToNumber("120")).toBe(120);
  });

  it("非数字返回 null，不瞎猜", () => {
    expect(chineseToNumber("很疼")).toBeNull();
    expect(chineseToNumber("")).toBeNull();
  });

  it("中文数字串换成阿拉伯数字，便于和标签同形比较", () => {
    expect(toArabicDigits("第3个")).toBe("第3个");
    expect(toArabicDigits("二十次")).toBe("20次");
  });
});

describe("数值提取", () => {
  it("带单位的口语数值", () => {
    expect(extractVoiceNumber("我走了二十米")).toBe(20);
    expect(extractVoiceNumber("差不多十秒吧")).toBe(10);
    expect(extractVoiceNumber("一百二十")).toBe(120);
  });

  it("阿拉伯数字优先，小数保留", () => {
    expect(extractVoiceNumber("3.5 秒")).toBe(3.5);
  });

  it("「有一点」是程度不是数值", () => {
    expect(extractVoiceNumber("有一点没劲")).toBeNull();
    expect(extractVoiceNumber("一直疼")).toBeNull();
  });

  it("没有数字时返回 null", () => {
    expect(extractVoiceNumber("没有")).toBeNull();
  });

  it("单位识别与归一（分→分钟、公分→厘米）", () => {
    expect(extractVoiceUnit("二十分钟")).toBe("分钟");
    expect(extractVoiceUnit("五秒")).toBe("秒");
    expect(extractVoiceUnit("三次")).toBe("次");
    expect(extractVoiceUnit("十分")).toBe("分钟");
    expect(extractVoiceUnit("十")).toBe("");
  });
});

describe("序数识别", () => {
  it("「第几个」「第几项」都能认", () => {
    expect(parseVoiceOrdinal("第二个")).toBe(2);
    expect(parseVoiceOrdinal("第 3 项")).toBe(3);
    expect(parseVoiceOrdinal("第三题")).toBe(3);
    expect(parseVoiceOrdinal("第十个")).toBe(10);
  });

  it("没有序数词返回 null", () => {
    expect(parseVoiceOrdinal("选三")).toBeNull();
    expect(parseVoiceOrdinal("没有")).toBeNull();
  });
});

describe("单选题匹配", () => {
  it("明确说「第几个」直接定位，置信度高", () => {
    const match = matchVoiceOption("第二个", SEVERITY);
    expect(match?.option.label).toBe("中度");
    expect(match?.confidence).toBe("high");
    expect(match?.tier).toBe("ordinal");
  });

  it("说的就是选项原文", () => {
    const match = matchVoiceOption("是", YES_NO);
    expect(match?.option.label).toBe("是");
    expect(match?.tier).toBe("exact");
  });

  it("一句话里带着选项原文，取最长的那个", () => {
    const match = matchVoiceOption("我觉得是中度吧", SEVERITY);
    expect(match?.option.label).toBe("中度");
    expect(match?.tier).toBe("contains");
  });

  it("长短选项同时命中时选更具体的（完全依赖 优于 需部分帮助 里的字面重叠）", () => {
    const match = matchVoiceOption("我现在完全依赖别人照顾", ADL_HELP);
    expect(match?.option.label).toBe("完全依赖");
  });

  it("「有」落到「是」，靠同义词，置信度为低", () => {
    const match = matchVoiceOption("有", YES_NO);
    expect(match?.option.label).toBe("是");
    expect(match?.confidence).toBe("low");
    expect(match?.tier).toBe("synonym");
  });

  it("「没有」落到「否」", () => {
    const match = matchVoiceOption("没有", YES_NO);
    expect(match?.option.label).toBe("否");
  });

  it("「不是」也落到「否」", () => {
    const match = matchVoiceOption("不是", YES_NO);
    expect(match?.option.label).toBe("否");
  });

  it("选项本身写「没有」时走精确匹配，不被同义词抢走", () => {
    const options = [{ value: "1", label: "有" }, { value: "0", label: "没有" }];
    const match = matchVoiceOption("没有", options);
    expect(match?.option.label).toBe("没有");
    expect(match?.tier).toBe("exact");
  });

  it("「有一点」落到「轻度」", () => {
    const match = matchVoiceOption("有一点", SEVERITY);
    expect(match?.option.label).toBe("轻度");
    expect(match?.confidence).toBe("low");
  });

  it("时间区间：「二十分钟」落到 0~30 分钟", () => {
    const match = matchVoiceOption("二十分钟", TIME_BANDS);
    expect(match?.option.value).toBe("a");
    expect(match?.tier).toBe("range");
  });

  it("时间区间：「九十分钟」落到 31~60 分钟区间之外的部分要正确", () => {
    const match = matchVoiceOption("九十分钟", TIME_BANDS);
    expect(match?.option.value).toBe("c");
  });

  it("时间区间：「三个多小时」落到超过 120 分钟不成立，返回 null", () => {
    expect(matchVoiceOption("三个多小时", TIME_BANDS)).toBeNull();
  });

  it("分值型选项：说「五分」不会错选第 5 个", () => {
    const scores = Array.from({ length: 11 }, (_, index) => ({
      value: String(index),
      label: `${index} 分`,
    }));
    const match = matchVoiceOption("五分", scores);
    expect(match?.option.label).toBe("5 分");
    expect(match?.tier).toBe("exact");
  });

  it("只说数字时按位置兜底，置信度为低", () => {
    const match = matchVoiceOption("2", SEVERITY);
    expect(match?.option.label).toBe("中度");
    expect(match?.confidence).toBe("low");
    expect(match?.tier).toBe("index");
  });

  it("数字超出选项数量时不硬凑", () => {
    expect(matchVoiceOption("第五个", SEVERITY)).toBeNull();
  });

  it("与题目无关的话不产生答案", () => {
    expect(matchVoiceOption("今天天气不错", YES_NO)).toBeNull();
    expect(matchVoiceOption("", YES_NO)).toBeNull();
    expect(matchVoiceOption("嗯", SEVERITY)).toBeNull();
  });

  it("选项为空时安全返回 null", () => {
    expect(matchVoiceOption("第二个", [])).toBeNull();
  });

  it("「每夜不超过 1 次」这类单值上界标签能被命中", () => {
    const options = [
      { value: "0", label: "从不漏尿" },
      { value: "1", label: "每夜不超过 1 次" },
      { value: "2", label: "每夜 2 次" },
    ];
    const match = matchVoiceOption("一次", options);
    expect(match?.option.value).toBe("1");
    expect(match?.tier).toBe("range");
  });
});

describe("多选题匹配", () => {
  const IADL = [
    { value: "a", label: "能自己做饭" },
    { value: "b", label: "洗澡需要帮助" },
    { value: "c", label: "能自己走路" },
  ];

  it("并列词切开后逐项命中", () => {
    const matches = matchVoiceOptions("能自己做饭、能自己走路", IADL);
    expect(matches.map((item) => item.option.value)).toEqual(["a", "c"]);
  });

  it("「还有」也能切", () => {
    const matches = matchVoiceOptions("洗澡需要帮助还有能自己走路", IADL);
    expect(matches.map((item) => item.option.value)).toEqual(["b", "c"]);
  });

  it("整句包含多个选项时全部收下", () => {
    const matches = matchVoiceOptions("我能自己做饭也能自己走路", IADL);
    expect(matches.map((item) => item.option.value)).toEqual(["a", "c"]);
  });

  it("只说一句模糊话不产生多选结果", () => {
    expect(matchVoiceOptions("都还行吧", IADL)).toEqual([]);
  });

  it("同一项说两遍只算一次", () => {
    const matches = matchVoiceOptions("能自己做饭，能自己做饭", IADL);
    expect(matches).toHaveLength(1);
  });

  it("结果按选项顺序排列，而不是说话顺序", () => {
    const matches = matchVoiceOptions("能自己走路、能自己做饭", IADL);
    expect(matches.map((item) => item.option.value)).toEqual(["a", "c"]);
  });
});

describe("真实题库片段（B.1 / B.5 / B.8 / B.15）", () => {
  /** B1-01 进食 */
  const B101 = [
    { value: "10", label: "可自行进食" },
    { value: "5", label: "需部分帮助" },
    { value: "0", label: "需极大帮助或完全依赖" },
  ];
  /** B15-00 是否机械通气 */
  const B1500 = [
    { value: "1", label: "是（插管，观察机械通气顺应性）" },
    { value: "0", label: "否（未插管，观察发声）" },
  ];
  /** B15-01 面部表情，分值直接写在标签里 */
  const B1501 = [
    { value: "1", label: "1 分：表情放松" },
    { value: "2", label: "2 分：部分紧绷（如皱眉）" },
    { value: "3", label: "3 分：完全紧绷（如眼睛紧闭）" },
    { value: "4", label: "4 分：面部扭曲" },
  ];
  /** 尿失禁条目 */
  const INCONTINENCE = [
    { value: "0", label: "从不漏尿" },
    { value: "1", label: "在未到达厕所之前就有漏尿" },
    { value: "2", label: "在咳嗽和打喷嚏时漏尿" },
  ];

  it("「我自己能吃」落到「可自行进食」", () => {
    const match = matchVoiceOption("我自己能吃", B101);
    expect(match?.option.label).toBe("可自行进食");
  });

  it("「需要帮忙」落到「需部分帮助」", () => {
    const match = matchVoiceOption("需要帮忙", B101);
    expect(match?.option.label).toBe("需部分帮助");
  });

  it("「全靠别人」落到「需极大帮助或完全依赖」", () => {
    const match = matchVoiceOption("全靠别人", B101);
    expect(match?.option.label).toBe("需极大帮助或完全依赖");
  });

  it("带括号说明的「是（插管…）」也能被「是」命中", () => {
    const match = matchVoiceOption("是", B1500);
    expect(match?.option.value).toBe("1");
  });

  it("「否」不会错落到「是（插管…）」", () => {
    const match = matchVoiceOption("否", B1500);
    expect(match?.option.value).toBe("0");
  });

  it("分值型标签：说「四分」直接命中 4 分档", () => {
    const match = matchVoiceOption("四分", B1501);
    expect(match?.option.value).toBe("4");
    expect(match?.tier).toBe("number_label");
  });

  it("分值型标签：说「2 分」命中 2 分档，而不是第 2 个", () => {
    const match = matchVoiceOption("2 分", B1501);
    expect(match?.option.value).toBe("2");
  });

  it("「没有漏尿」落到「从不漏尿」", () => {
    const match = matchVoiceOption("没有漏尿", INCONTINENCE);
    expect(match?.option.label).toBe("从不漏尿");
  });

  it("「咳嗽打喷嚏的时候漏」落到对应条目", () => {
    const match = matchVoiceOption("咳嗽打喷嚏的时候漏尿", INCONTINENCE);
    expect(match?.option.label).toBe("在咳嗽和打喷嚏时漏尿");
  });

  it("「不知道」一律不选，宁可让老人再确认", () => {
    expect(matchVoiceOption("不知道", B101)).toBeNull();
    expect(matchVoiceOption("记不清了", B101)).toBeNull();
    expect(matchVoiceOption("说不好", B1500)).toBeNull();
    expect(matchVoiceOption("不太确定", B1501)).toBeNull();
  });

  it("频率区间：「一星期两三次」落到「每周 2~3 次」", () => {
    const options = [
      { value: "0", label: "从不" },
      { value: "1", label: "大约每周 1 次或更少" },
      { value: "2", label: "每周 2~3 次" },
      { value: "3", label: "大约每天 1 次" },
    ];
    const match = matchVoiceOption("一星期两三次", options);
    expect(match?.option.label).toBe("每周 2~3 次");
  });
});

describe("能否用语音作答", () => {
  it("有选项的题都可以", () => {
    expect(canAnswerByVoice({ input_type: "single", options: SEVERITY })).toBe(true);
    expect(canAnswerByVoice({ input_type: "multi", options: SEVERITY })).toBe(true);
  });

  it("纯填空题也可以（说数字）", () => {
    expect(canAnswerByVoice({ input_type: "number" })).toBe(true);
  });

  it("没有选项又没有输入类型的题不行", () => {
    expect(canAnswerByVoice({ input_type: "single", options: [] })).toBe(false);
  });
});
