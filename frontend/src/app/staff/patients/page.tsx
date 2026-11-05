"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Search, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { ageFromBirthDate, formatDate } from "@/lib/format";
import type { Paged, Patient, PatientCreateBody } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ClinEmpty,
  ClinError,
  ClinLoading,
  ClinPageHeader,
  ClinSection,
} from "@/app/staff/_components/clinical";

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
    <div>
      <ClinPageHeader
        title="患者管理"
        description="查询患者档案，进入详情页维护预问诊内容、查看评估、报告与匹配结果。"
        actions={
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            新建患者
          </Button>
        }
      />

      <ClinSection title="检索">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Label htmlFor="patient-keyword">关键字</Label>
            <Input
              id="patient-keyword"
              className="mt-1"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="姓名 / 编号 / 手机号"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            查询
          </Button>
        </div>
      </ClinSection>

      <ClinSection title="患者列表">
        {loading ? (
          <ClinLoading label="正在加载患者列表…" />
        ) : error ? (
          <ClinError message={error} onRetry={() => void load()} />
        ) : patients.length === 0 ? (
          <ClinEmpty message="没有找到符合条件的患者。" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left">
                <thead className="border-b border-clin-border bg-clin-muted">
                  <tr>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      姓名
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      编号
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      性别
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      年龄
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      联系电话
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      建档日期
                    </th>
                    <th className="px-3 py-2 text-clin-xs font-medium text-clin-fg-muted">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {patients.map((patient) => (
                    <tr
                      key={patient.id}
                      className="border-b border-clin-border transition-colors duration-150 last:border-0 hover:bg-clin-muted"
                    >
                      <td className="px-3 py-2 text-clin-sm font-medium text-clin-fg">
                        {patient.name}
                      </td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                        {patient.code ?? patient.id}
                      </td>
                      <td className="px-3 py-2 text-clin-sm text-clin-fg">{patient.gender}</td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg">
                        {patient.age !== undefined
                          ? `${patient.age} 岁`
                          : ageFromBirthDate(patient.birth_date)}
                      </td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                        {patient.phone || "—"}
                      </td>
                      <td className="px-3 py-2 text-clin-sm tabular-nums text-clin-fg-muted">
                        {formatDate(patient.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/staff/patients/${patient.id}`}
                          className="text-clin-sm text-clin-accent hover:underline"
                        >
                          进入档案
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-clin-xs text-clin-fg-muted">
              <span>共 {total} 位患者</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  上一页
                </Button>
                <span className="tabular-nums">
                  第 {page} / {totalPages} 页
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </ClinSection>

      {/* 新建患者：确认框（shadcn dialog） */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建患者</DialogTitle>
            <DialogDescription>
              填写基础信息后保存。身份证号入库即按掩码存储，响应只回掩码值。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="new-name">姓名</Label>
              <Input
                id="new-name"
                className="mt-1"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="new-gender">性别</Label>
              <div className="mt-1 flex gap-2">
                {["女", "男"].map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={form.gender === option ? "default" : "outline"}
                    onClick={() => setForm({ ...form, gender: option })}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="new-birth">出生日期</Label>
              <Input
                id="new-birth"
                type="date"
                className="mt-1"
                value={form.birth_date}
                onChange={(event) => setForm({ ...form, birth_date: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="new-phone">联系电话</Label>
              <Input
                id="new-phone"
                className="mt-1"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="new-idcard">身份证号</Label>
              <Input
                id="new-idcard"
                className="mt-1"
                value={form.id_card}
                onChange={(event) => setForm({ ...form, id_card: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="new-emergency">紧急联系人</Label>
              <Input
                id="new-emergency"
                className="mt-1"
                value={form.emergency_contact}
                onChange={(event) =>
                  setForm({ ...form, emergency_contact: event.target.value })
                }
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="new-address">居住地址</Label>
              <Input
                id="new-address"
                className="mt-1"
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setForm(EMPTY_FORM);
                setFormOpen(false);
              }}
            >
              取消
            </Button>
            <Button size="sm" loading={saving} onClick={() => void handleCreate()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
