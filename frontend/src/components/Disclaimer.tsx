/**
 * 统一免责声明文案（契约 §6 术语约束：所有匹配结果与提醒必须附带）。
 */
export const MATCH_DISCLAIMER = "结果仅供参考，不构成诊断，请及时咨询医生。";

/** 免责声明条 */
export function Disclaimer({ text }: { text?: string }) {
  return (
    <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-elder text-amber-900">
      {text ?? MATCH_DISCLAIMER}
    </p>
  );
}
