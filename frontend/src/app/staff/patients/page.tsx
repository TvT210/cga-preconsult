"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { ageFromBirthDate, formatDate } from "@/lib/format";
import type { Paged, Patient, PatientCreateBody } from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { EmptyState, ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";

function toItems<T>(payload: T[] | Paged<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.items ?? [];
}

const EMPTY_FORM: PatientCreateBody = {
  name: "",
  gender: "女",
  birth_date: "",
  phone: "",
  id_card: "",
  address: "",
  emergency_contact: "",
};

export default function StaffPatientsPage() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [size] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<PatientCreateBody>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.get<Patient[] | Paged<Patient>>("/patients", {
        keyword: keyword.trim() || undefined,
        page,
        size,
      });
      const items = toItems(payload);
      setPatients(items);
      if (!Array.isArray(payload) && typeof payload.total === "number") {
        setTotal(payload.total);
      } else {
        setTotal(items.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法获取患者列表。");
    } finally {
      setLoading(false);
    }
  }, [keyword, page, size]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(async () => {
    if (!form.name.trim()) {
      return;
    }
    setSaving(true);
    try {
      await api.post<Patient>("/patients", form);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      await load();
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setSaving(false);
    }
  }, [form, load]);

  const totalPages = Math.max(1, Math.ceil(total / size));

  return (
    <div className="space-y-6">
      <PageHeader
        title="患者管理"
        description="查询患者档案，进入详情页维护预问诊内容、查看评估、报告与匹配结果。"
        actions={
          <BigButton size="lg" onClick={() => setFormOpen((prev) => !prev)}>
            {formOpen ? "收起新建表单" : "新建患者"}
          </BigButton>
        }
      />

      {formOpen ? (
        <section className="card card-pad">
          <h2 className="text-elder-lg font-semibold text-ink">新建患者</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <label className="field-label" htmlFor="new-name">
                姓名
              </label>
              <input
                id="new-name"
                className="field-input"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="new-gender">
                性别
              </label>
              <select
                id="new-gender"
                className="field-select"
                value={form.gender}
                onChange={(event) => setForm({ ...form, gender: event.target.value })}
              >
                <option value="女">女</option>
                <option value="男">男</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="new-birth">
                出生日期
              </label>
              <input
                id="new-birth"
                type="date"
                className="field-input"
                value={form.birth_date}
                onChange={(event) => setForm({ ...form, birth_date: event.target.value })}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="new-phone">
                联系电话
              </label>
              <input
                id="new-phone"
                className="field-input"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="new-idcard">
                身份证号
              </label>
              <input
                id="new-idcard"
                className="field-input"
                value={form.id_card}
                onChange={(event) => setForm({ ...form, id_card: event.target.value })}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="new-emergency">
                紧急联系人
              </label>
              <input
                id="new-emergency"
                className="field-input"
                value={form.emergency_contact}
                onChange={(event) =>
                  setForm({ ...form, emergency_contact: event.target.value })
                }
              />
            </div>
            <div className="md:col-span-3">
              <label className="field-label" htmlFor="new-address">
                居住地址
              </label>
              <input
                id="new-address"
                className="field-input"
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <BigButton size="lg" loading={saving} onClick={() => void handleCreate()}>
              保存
            </BigButton>
            <BigButton
              variant="ghost"
              size="lg"
              onClick={() => {
                setForm(EMPTY_FORM);
                setFormOpen(false);
              }}
            >
              取消
            </BigButton>
          </div>
        </section>
      ) : null}

      <section className="card card-pad">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[240px] flex-1">
            <label className="field-label" htmlFor="patient-keyword">
              检索
            </label>
            <input
              id="patient-keyword"
              className="field-input"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="姓名 / 编号 / 手机号"
            />
          </div>
          <BigButton variant="secondary" size="lg" onClick={() => void load()}>
            查询
          </BigButton>
        </div>
      </section>

      {loading ? (
        <LoadingState label="正在加载患者列表…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : patients.length === 0 ? (
        <EmptyState message="没有找到符合条件的患者。" />
      ) : (
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">姓名</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">编号</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">性别</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">年龄</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">联系电话</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">建档日期</th>
                  <th className="px-5 py-3 text-elder font-semibold text-ink">操作</th>
                </tr>
              </thead>
              <tbody>
                {patients.map((patient) => (
                  <tr key={patient.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-3 text-elder font-semibold text-ink">
                      {patient.name}
                    </td>
                    <td className="px-5 py-3 text-elder text-ink-soft">
                      {patient.code ?? patient.id}
                    </td>
                    <td className="px-5 py-3 text-elder text-ink">{patient.gender}</td>
                    <td className="px-5 py-3 text-elder text-ink">
                      {patient.age !== undefined
                        ? `${patient.age} 岁`
                        : ageFromBirthDate(patient.birth_date)}
                    </td>
                    <td className="px-5 py-3 text-elder text-ink-soft">
                      {patient.phone || "—"}
                    </td>
                    <td className="px-5 py-3 text-elder text-ink-soft">
                      {formatDate(patient.created_at)}
                    </td>
                    <td className="px-5 py-3">
                      <Link href={`/staff/patients/${patient.id}`}>
                        <BigButton variant="secondary">进入档案</BigButton>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-elder text-ink-soft">
            <span>共 {total} 位患者</span>
            <div className="flex gap-3">
              <BigButton
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                上一页
              </BigButton>
              <span className="self-center">
                第 {page} / {totalPages} 页
              </span>
              <BigButton
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              >
                下一页
              </BigButton>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
