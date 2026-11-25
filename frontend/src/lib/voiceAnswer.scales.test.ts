import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { matchVoiceOption } from "./voiceAnswer";

/**
 * 用仓库里的 21 张量表做真实数据回归。
 *
 * 核心不变式：把选项原文当作老人说的话喂回去，必须原样命中自己。
 * 这条能挡住「短标签抢先命中」「包含关系把答案抢走」这类排序错误——
 * 手写夹具很难覆盖到 362 个真实选项。
 *
 * 题库目录不在（例如只拿到 frontend 目录）时自动跳过，不阻塞 CI。
 */
const ROOT = path.resolve(process.cwd(), "../docs/structured/assessment-scales");
const AVAILABLE = fs.existsSync(ROOT);

interface RawOption {
  value: string;
  label: string;
}

describe.skipIf(!AVAILABLE)("真实题库回归", () => {
  it("每个选项念出来都能命中自己", () => {
    const files = fs.readdirSync(ROOT).filter((name) => name.endsWith(".json"));
    const problems: string[] = [];
    let checked = 0;

    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf-8"));
      for (const section of data.sections ?? []) {
        for (const question of section.questions ?? []) {
          if (question.input_type !== "single") continue;
          const options: RawOption[] = question.options ?? [];
          if (options.length < 2) continue;
          for (const option of options) {
            checked += 1;
            const match = matchVoiceOption(option.label, options);
            if (!match) {
              problems.push(`${file} ${question.code} 未命中自己: ${option.label}`);
              continue;
            }
            if (match.option.value !== option.value) {
              problems.push(
                `${file} ${question.code} 误命中: 说「${option.label}」→「${match.option.label}」`,
              );
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(300);
    expect(problems).toEqual([]);
  });
});
