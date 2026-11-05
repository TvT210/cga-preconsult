"use client";

import type { ConsentRecord, Preconsult } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ClinSection } from "@/app/staff/_components/clinical";

/**
 * 预问诊 tab（医护端 · **只读**）。
 *
 * 归属说明：预问诊的**采集与录入**属线 A（患者端 / 家属端），
 * 医护端只做查看，不提供二次编辑表单，避免两端出现两份采集实现。
 * 需要补充信息时，请引导老人或家属在患者端重新发起采集。
 */

function text(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) {
    return value.length
      ? value
          .map((item) =>
            item && typeof item === "object"
              ? Object.values(item as Record<string, unknown>)
                  .map((one) => (one === undefined || one === null ? "" : String(one)))
                  .join(" / ")
              : String(item),
          )
          .join("、")
      : "—";
  }
  if (typeof value === "object") {
    return (
      Object.entries(value as Record<string, unknown>)
        .filter(([, one]) => one !== undefined && one !== null && one !== "")
        .map(([key, one]) => `${key}：${String(one)}`)
        .join("、") || "—"
    );
  }
  return String(value);
}

/** 只读字段：标签 + 值，无边框、无阴影 */
function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="border-b border-clin-border py-2 last:border-b-0">
      <div className="text-clin-xs text-clin-fg-muted">{label}</div>
      <div className="mt-0.5 text-clin-sm text-clin-fg">{text(value)}</div>
    </div>
  );
}

export function PreconsultTab({
  preconsult,
  consents,
  onRecordConsent,
}: {
  preconsult: Preconsult;
  consents: ConsentRecord[];
  onRecordConsent: () => void;
}) {
  const basic = preconsult.basic ?? {};
  const chief = preconsult.chief_complaint ?? {};
  const history = preconsult.history ?? {};
  const lifestyle = preconsult.lifestyle ?? {};
  const proxy = preconsult.proxy ?? {};

  return (
    <div>
      <div className="mb-6 rounded-clin border border-clin-warning px-4 py-3 text-clin-sm text-clin-fg">
        预问诊内容由老人或家属在<strong>患者端</strong>采集与补充，本页仅供医护查看。
        如需补充信息，请引导老人/家属在患者端重新发起采集；此处不提供二次编辑。
      </div>

      <ClinSection
        title="知情同意"
        extra={
          <Button variant="outline" size="sm" onClick={onRecordConsent}>
            记录同意
          </Button>
        }
      >
        {consents.length ? (
          <ul className="divide-y divide-clin-border border-y border-clin-border">
            {consents.map((consent, index) => (
              <li
                key={consent.id ?? index}
                className="py-2 text-clin-sm text-clin-fg-muted"
              >
                {consent.agreed ? "已同意" : "未同意"}
                {consent.scope ? ` · ${consent.scope}` : ""} ·{" "}
                {formatDateTime(consent.created_at)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-clin-sm text-clin-fg-subtle">暂无同意记录。</p>
        )}
      </ClinSection>

      <ClinSection title="基本信息">
        <div className="grid gap-x-8 md:grid-cols-3">
          <Field label="性别" value={basic.gender} />
          <Field label="出生日期" value={basic.birth_date} />
          <Field label="婚姻状况" value={basic.marital_status} />
          <Field label="文化程度" value={basic.education} />
          <Field label="居住状况" value={basic.living_status} />
          <Field label="医疗费别" value={basic.medical_insurance} />
          <Field label="联系人" value={basic.contact_name} />
          <Field label="联系人电话" value={basic.contact_phone} />
        </div>
      </ClinSection>

      <ClinSection title="主诉与现病史">
        <div className="grid gap-x-8 md:grid-cols-2">
          <Field label="主诉" value={chief.text} />
          <Field label="起病时间" value={chief.onset} />
          <Field label="部位" value={chief.site} />
          <Field label="性质" value={chief.nature} />
          <Field label="严重程度" value={chief.severity} />
          <Field label="病程" value={chief.course} />
          <Field label="伴随症状" value={chief.associated} />
        </div>
      </ClinSection>

      <ClinSection title="既往史、用药与过敏">
        <div className="grid gap-x-8 md:grid-cols-3">
          <Field label="既往病史" value={history.conditions} />
          <Field label="当前用药" value={history.medications} />
          <Field label="过敏史" value={history.allergies} />
        </div>
      </ClinSection>

      <ClinSection title="生活方式与跌倒史">
        <div className="grid gap-x-8 md:grid-cols-3">
          <Field label="吸烟" value={lifestyle.smoking} />
          <Field label="饮酒" value={lifestyle.drinking} />
          <Field label="饮食" value={lifestyle.diet} />
          <Field label="活动" value={lifestyle.activity} />
          <Field label="睡眠" value={lifestyle.sleep} />
          <Field label="跌倒史" value={lifestyle.falls} />
        </div>
      </ClinSection>

      <ClinSection title="代答信息">
        <div className="grid gap-x-8 md:grid-cols-3">
          <Field label="是否代答" value={proxy.is_proxy ? "是" : "否"} />
          <Field label="代答人" value={proxy.proxy_name} />
          <Field label="与老人关系" value={proxy.proxy_relation} />
        </div>
      </ClinSection>
    </div>
  );
}
