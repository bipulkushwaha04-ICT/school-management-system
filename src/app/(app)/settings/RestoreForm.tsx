"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/ui";

export function RestoreForm() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirm(`Restore from "${file.name}"? This replaces all of this school's current data and signs everyone in the school out.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/data?op=restore", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Restore failed");
      setMsg({ ok: true, text: `Restored ${j.tables} tables successfully.` });
      if (fileRef.current) fileRef.current.value = "";
    } catch (ex: any) {
      setMsg({ ok: false, text: ex.message ?? "Restore failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className={`btn-ghost cursor-pointer ${busy ? "opacity-50" : ""}`}>
        <Icon name="upload" className="w-4 h-4" /> Restore backup
        <input ref={fileRef} type="file" accept="application/json" className="hidden" disabled={busy} onChange={onFile} />
      </label>
      {busy && <span className="ml-2 text-xs font-bold text-muted">Restoring…</span>}
      {msg && <p className={`mt-2 text-xs font-bold ${msg.ok ? "text-forest" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
