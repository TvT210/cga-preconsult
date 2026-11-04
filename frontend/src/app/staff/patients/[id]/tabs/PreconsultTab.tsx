"use client";

import type { ConsentRecord, Preconsult } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { BigButton } from "@/components/BigButton";
import { SectionTitle } from "@/components/PageHeader";

/** 以顿号或逗号分隔的文本转数组 */
function splitList(text: string): string[] {
  return text
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 每行一条，用竖线分隔字段 */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function linesToText(items?: unknown[]): string {
  if (!Array.isArray(items) || !items.length) return "";
  return items
    .map((item) => {
      if (item && typeof item === "object") {
        return Object.values(item as Record<string, unknown>)
          .map((value) => (value === undefined || value === null ? "" : String(value)))
          .join("|");
      }
      return item === undefined || item === null ? "" : String(item);
    })
    .join("\n");
}

/** 预问诊 tab：基本信息、主诉、既往史、生活方式与代答信息 */
export function PreconsultTab({
  preconsult,
  onChange,
  consents,
  onRecordConsent,
  onSave,
  saving,
}: {
  preconsult: Preconsult;
  onChange: (next: Preconsult) => void;
  consents: ConsentRecord[];
  onRecordConsent: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const basic = preconsult.basic ?? {};
  const chief = preconsult.chief_complaint ?? {};
  const history = preconsult.history ?? {};
  const lifestyle = preconsult.lifestyle ?? {};
  const proxy = preconsult.proxy ?? {};

  return (
    <div className="space-y-5">
      <section className="card card-pad">
        <SectionTitle
          title="知情同意"
          extra={
            <BigButton variant="secondary" onClick={onRecordConsent}>
              记录同意
            </BigButton>
          }
        />
        {consents.length ? (
          <ul className="space-y-2">
            {consents.map((consent, index) => (
              <li
                key={consent.id ?? index}
                className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-elder text-ink-soft"
              >
                {consent.agreed ? "已同意" : "未同意"}
                {consent.scope ? ` · ${consent.scope}` : ""} ·{" "}
                {formatDateTime(consent.created_at)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-elder text-ink-mute">暂无同意记录。</p>
        )}
      </section>

      <section className="card card-pad space-y-5">
        <SectionTitle title="基本信息" />
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="field-label" htmlFor="basic-gender">
              性别
            </label>
            <input
              id="basic-gender"
              className="field-input"
              value={basic.gender ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, gender: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-birth">
              出生日期
            </label>
            <input
              id="basic-birth"
              type="date"
              className="field-input"
              value={basic.birth_date ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, birth_date: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-marital">
              婚姻状况
            </label>
            <input
              id="basic-marital"
              className="field-input"
              value={basic.marital_status ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, marital_status: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-education">
              文化程度
            </label>
            <input
              id="basic-education"
              className="field-input"
              value={basic.education ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, education: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-living">
              居住状况
            </label>
            <input
              id="basic-living"
              className="field-input"
              value={basic.living_status ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, living_status: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-insurance">
              医疗费别
            </label>
            <input
              id="basic-insurance"
              className="field-input"
              value={basic.medical_insurance ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, medical_insurance: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-contact">
              联系人
            </label>
            <input
              id="basic-contact"
              className="field-input"
              value={basic.contact_name ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, contact_name: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="basic-contact-phone">
              联系人电话
            </label>
            <input
              id="basic-contact-phone"
              className="field-input"
              value={basic.contact_phone ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  basic: { ...basic, contact_phone: event.target.value },
                })
              }
            />
          </div>
        </div>
      </section>

      <section className="card card-pad space-y-4">
        <SectionTitle title="主诉与现病史" />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="field-label" htmlFor="chief-text">
              主诉
            </label>
            <textarea
              id="chief-text"
              className="field-input min-h-[90px]"
              value={chief.text ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: { ...chief, text: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="chief-onset">
              起病时间
            </label>
            <input
              id="chief-onset"
              className="field-input"
              value={chief.onset ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: { ...chief, onset: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="chief-site">
              部位
            </label>
            <input
              id="chief-site"
              className="field-input"
              value={chief.site ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: { ...chief, site: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="chief-nature">
              性质
            </label>
            <input
              id="chief-nature"
              className="field-input"
              value={chief.nature ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: { ...chief, nature: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="chief-severity">
              严重程度（0~10）
            </label>
            <input
              id="chief-severity"
              type="number"
              min={0}
              max={10}
              className="field-input"
              value={chief.severity ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: {
                    ...chief,
                    severity:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                  },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="chief-course">
              病程
            </label>
            <input
              id="chief-course"
              className="field-input"
              value={chief.course ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: { ...chief, course: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="chief-associated">
              伴随症状（顿号分隔）
            </label>
            <input
              id="chief-associated"
              className="field-input"
              value={(chief.associated ?? []).join("、")}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  chief_complaint: {
                    ...chief,
                    associated: splitList(event.target.value),
                  },
                })
              }
            />
          </div>
        </div>
      </section>

      <section className="card card-pad space-y-4">
        <SectionTitle title="既往史、用药史与过敏史" />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="history-conditions">
              慢性病清单（顿号分隔）
            </label>
            <input
              id="history-conditions"
              className="field-input"
              value={(history.conditions ?? []).join("、")}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  history: {
                    ...history,
                    conditions: splitList(event.target.value),
                  },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="history-medications">
              长期用药（每行一条：名称|剂量|开始时间）
            </label>
            <textarea
              id="history-medications"
              className="field-input min-h-[110px]"
              value={linesToText(history.medications)}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  history: {
                    ...history,
                    medications: splitLines(event.target.value).map((line) => {
                      const [name, dose, since] = line.split("|");
                      return { name: name ?? "", dose, since };
                    }),
                  },
                })
              }
            />
          </div>
          <div className="md:col-span-2">
            <label className="field-label" htmlFor="history-allergies">
              过敏史（每行一条：药物|反应）
            </label>
            <textarea
              id="history-allergies"
              className="field-input min-h-[90px]"
              value={linesToText(history.allergies)}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  history: {
                    ...history,
                    allergies: splitLines(event.target.value).map((line) => {
                      const [name, reaction] = line.split("|");
                      return { name: name ?? "", reaction };
                    }),
                  },
                })
              }
            />
          </div>
        </div>
      </section>

      <section className="card card-pad space-y-4">
        <SectionTitle title="生活方式" />
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
            <input
              type="checkbox"
              className="h-7 w-7"
              checked={Boolean(lifestyle.smoking)}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  lifestyle: { ...lifestyle, smoking: event.target.checked },
                })
              }
            />
            吸烟
          </label>
          <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
            <input
              type="checkbox"
              className="h-7 w-7"
              checked={Boolean(lifestyle.drinking)}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  lifestyle: { ...lifestyle, drinking: event.target.checked },
                })
              }
            />
            饮酒
          </label>
          <div>
            <label className="field-label" htmlFor="life-diet">
              饮食
            </label>
            <input
              id="life-diet"
              className="field-input"
              value={lifestyle.diet ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  lifestyle: { ...lifestyle, diet: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="life-activity">
              活动
            </label>
            <input
              id="life-activity"
              className="field-input"
              value={lifestyle.activity ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  lifestyle: { ...lifestyle, activity: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="life-sleep">
              睡眠
            </label>
            <input
              id="life-sleep"
              className="field-input"
              value={lifestyle.sleep ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  lifestyle: { ...lifestyle, sleep: event.target.value },
                })
              }
            />
          </div>
          <div className="md:col-span-2">
            <label className="field-label" htmlFor="life-falls">
              跌倒史（每行一条：时间|地点|诱因|损伤）
            </label>
            <textarea
              id="life-falls"
              className="field-input min-h-[90px]"
              value={linesToText(lifestyle.falls)}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  lifestyle: {
                    ...lifestyle,
                    falls: splitLines(event.target.value).map((line) => {
                      const [time, place, cause, injury] = line.split("|");
                      return { time, place, cause, injury };
                    }),
                  },
                })
              }
            />
          </div>
        </div>
      </section>

      <section className="card card-pad space-y-4">
        <SectionTitle title="代答信息" />
        <div className="grid gap-4 md:grid-cols-3">
          <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
            <input
              type="checkbox"
              className="h-7 w-7"
              checked={Boolean(proxy.is_proxy)}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  proxy: { ...proxy, is_proxy: event.target.checked },
                })
              }
            />
            由家属代答
          </label>
          <div>
            <label className="field-label" htmlFor="proxy-name">
              代答人姓名
            </label>
            <input
              id="proxy-name"
              className="field-input"
              value={proxy.proxy_name ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  proxy: { ...proxy, proxy_name: event.target.value },
                })
              }
            />
          </div>
          <div>
            <label className="field-label" htmlFor="proxy-relation">
              与老人关系
            </label>
            <input
              id="proxy-relation"
              className="field-input"
              value={proxy.proxy_relation ?? ""}
              onChange={(event) =>
                onChange({
                  ...preconsult,
                  proxy: { ...proxy, proxy_relation: event.target.value },
                })
              }
            />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <BigButton size="lg" loading={saving} onClick={onSave}>
          保存预问诊
        </BigButton>
      </div>
    </div>
  );
}
