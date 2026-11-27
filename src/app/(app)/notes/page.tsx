import { eq, and, sql, desc } from "drizzle-orm";
import { db } from "@/db";
import { notes, classes, sections, subjects, users, enrollments, classSubjects, parentChildren, academicYears } from "@/db/schema";
import { requireUser, requireRole, logAudit } from "@/lib/auth";
import { flashTo } from "@/actions/auth";
import { fmtDate } from "@/lib/grading";
import { currentSchoolId } from "@/lib/tenant";
import { PageHead, Badge, FormModal, ConfirmButton, Icon, Empty } from "@/components/ui";
import { FileNoteForm, ReadNote } from "./FileNoteForm";
import { NoteForm } from "./NoteForm";

export const dynamic = "force-dynamic";

export async function saveNote(formData: FormData) {
  "use server";
  const user = await requireUser();
  if (user.role === "student" || user.role === "parent") await flashTo("/dashboard", "Not permitted.", true);
  const schoolId = await currentSchoolId();
  const title = String(formData.get("title") ?? "").trim();
  const classId = formData.get("classId") ? Number(formData.get("classId")) : null;
  const sectionId = formData.get("sectionId") ? Number(formData.get("sectionId")) : null;
  const subjectId = formData.get("subjectId") ? Number(formData.get("subjectId")) : null;
  const type = String(formData.get("type") ?? "text");
  const content = String(formData.get("content") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim() || null;
  if (!title) await flashTo("/notes", "Title is required.", true);
  if (type === "text" && !content) await flashTo("/notes", "Note content is required.", true);
  if (type === "link" && !url) await flashTo("/notes", "Link URL is required.", true);
  if (!["text", "link"].includes(type)) await flashTo("/notes", "Unsupported note type.", true);
  if (type === "link" && !/^https?:\/\/[^\s]+$/i.test(url ?? "")) {
    await flashTo("/notes", "Links must start with http:// or https://.", true);
  }
  for (const v of [classId, sectionId, subjectId]) {
    if (v !== null && (!Number.isInteger(v) || v <= 0)) await flashTo("/notes", "Invalid class, section or subject.", true);
  }
  if ((sectionId || subjectId) && !classId) await flashTo("/notes", "Select a class before a section or subject.", true);
  if (classId) {
    const [c] = await db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId))).limit(1);
    if (!c) await flashTo("/notes", "Selected class does not exist.", true);
  }
  if (sectionId) {
    const [sec] = await db.select({ id: sections.id }).from(sections).where(and(eq(sections.id, sectionId), eq(sections.classId, classId!), eq(sections.schoolId, schoolId))).limit(1);
    if (!sec) await flashTo("/notes", "Selected section does not belong to that class.", true);
  }
  if (subjectId) {
    const [sub] = await db.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.id, subjectId), eq(subjects.schoolId, schoolId))).limit(1);
    if (!sub) await flashTo("/notes", "Selected subject does not exist.", true);
  }
  if (user.role === "teacher" && (!user.teacherId || !classId)) {
    await flashTo("/notes", "Select one of your assigned classes.", true);
  }

  // teachers can only publish to their assigned classes
  if (user.role === "teacher" && classId) {
    const mine = await db.select().from(classSubjects).where(and(eq(classSubjects.teacherId, user.teacherId!), eq(classSubjects.schoolId, schoolId)));
    if (!mine.some((m) => m.classId === classId)) await flashTo("/notes", "You can only publish notes to your assigned classes.", true);
  }

  const [year] = await db.select().from(academicYears).where(and(eq(academicYears.status, "active"), eq(academicYears.schoolId, schoolId))).limit(1);
  const [row] = await db
    .insert(notes)
    .values({ schoolId, title, classId, sectionId, subjectId, type, content: content || null, url, academicYearId: year?.id ?? null, uploadedById: user.id })
    .returning({ id: notes.id });
  await logAudit(user.id, "Uploaded note", "note", row.id, title);
  await flashTo("/notes", "Study material published.");
}

export async function deleteNote(formData: FormData) {
  "use server";
  const user = await requireUser();
  const schoolId = await currentSchoolId();
  const id = Number(formData.get("id"));
  const [row] = await db.select().from(notes).where(and(eq(notes.id, id), eq(notes.schoolId, schoolId))).limit(1);
  if (!row) return;
  if (user.role !== "admin" && row.uploadedById !== user.id) await flashTo("/notes", "You can only delete your own notes.", true);
  if (row.url && row.url.startsWith("/uploads/")) {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const full = path.join(process.cwd(), "public", row.url);
      if (full.startsWith(path.join(process.cwd(), "public"))) fs.unlinkSync(full);
    } catch {}
  } else if (row.url && /^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(row.url) && process.env.BLOB_READ_WRITE_TOKEN) {
    const { del } = await import("@vercel/blob");
    await del(row.url).catch(() => undefined);
  }
  await db.delete(notes).where(and(eq(notes.id, id), eq(notes.schoolId, schoolId)));
  await logAudit(user.id, "Deleted note", "note", id, row.title);
  await flashTo("/notes", "Note removed.");
}

export default async function NotesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const schoolId = await currentSchoolId();
  const sp = await searchParams;
  const isAdmin = user.role === "admin";
  const canUpload = user.role === "admin" || user.role === "teacher";

  const [allClasses, allSections, allSubjects, classFilter] = await Promise.all([
    db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(classes.sortOrder),
    db.select().from(sections).where(eq(sections.schoolId, schoolId)).orderBy(sections.name),
    db.select().from(subjects).where(eq(subjects.schoolId, schoolId)).orderBy(subjects.name),
    sp.classId ? db.select().from(classes).where(and(eq(classes.id, Number(sp.classId)), eq(classes.schoolId, schoolId))).limit(1) : Promise.resolve(null),
  ]);

  // scope by role
  let where = sql`${notes.schoolId} = ${schoolId}`;
  if (user.role === "student") {
    where = sql`${notes.schoolId} = ${schoolId} and ${notes.classId} in (select class_id from enrollments where student_id = ${user.studentId} and school_id = ${schoolId} and status = 'active')`;
  } else if (user.role === "parent") {
    where = sql`${notes.schoolId} = ${schoolId} and ${notes.classId} in (select class_id from enrollments where student_id in (select student_id from parent_children where user_id = ${user.id} and school_id = ${schoolId}) and school_id = ${schoolId} and status = 'active')`;
  } else if (user.role === "teacher") {
    where = sql`${notes.schoolId} = ${schoolId} and (${notes.classId} in (select class_id from class_subjects where teacher_id = ${user.teacherId} and school_id = ${schoolId}) or ${notes.uploadedById} = ${user.id})`;
  }

  const clsFilter = classFilter ? classFilter[0] : null;
  const list = await db
    .select({
      n: notes,
      className: classes.name,
      section: sections.name,
      subject: subjects.name,
      by: users.name,
    })
    .from(notes)
    .leftJoin(classes, and(eq(classes.id, notes.classId), eq(classes.schoolId, schoolId)))
    .leftJoin(sections, and(eq(sections.id, notes.sectionId), eq(sections.schoolId, schoolId)))
    .leftJoin(subjects, and(eq(subjects.id, notes.subjectId), eq(subjects.schoolId, schoolId)))
    .leftJoin(users, and(eq(users.id, notes.uploadedById), eq(users.schoolId, schoolId)))
    .where(clsFilter ? and(where, sql`${notes.classId} = ${clsFilter.id}`) : where)
    .orderBy(desc(notes.createdAt))
    .limit(80);

  let myClasses: { id: number; name: string }[] = [];
  if (user.role === "teacher") {
    const rows = await db
      .select({ id: classSubjects.classId, name: classes.name })
      .from(classSubjects)
      .innerJoin(classes, and(eq(classes.id, classSubjects.classId), eq(classes.schoolId, schoolId)))
      .where(and(eq(classSubjects.teacherId, user.teacherId!), eq(classSubjects.schoolId, schoolId)));
    myClasses = rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
  }

  return (
    <>
      <PageHead title="Notes & Study Materials" sub={canUpload ? "Share text notes, links and files with your classes" : "Materials assigned to your class"}>
        {canUpload && (
          <>
            <FormModal title="Upload note / link" icon="plus" label="New note / link" wide>
              <NoteForm action={saveNote} classes={user.role === "teacher" ? myClasses : allClasses} allSections={allSections} allSubjects={allSubjects} />
            </FormModal>
            <FileNoteForm
              classes={user.role === "teacher" ? myClasses : allClasses}
              allSections={allSections}
              allSubjects={allSubjects}
              userId={user.id}
            />
          </>
        )}
      </PageHead>

      <div className="card p-3 mb-4 flex gap-2 overflow-x-auto no-print">
        <a href="/notes" className={`btn-sm shrink-0 ${!clsFilter ? "btn-primary" : "btn-ghost"}`}>All</a>
        {allClasses.map((c) => (
          <a key={c.id} href={`/notes?classId=${c.id}`} className={`btn-sm shrink-0 ${clsFilter?.id === c.id ? "btn-primary" : "btn-ghost"}`}>
            {c.name}
          </a>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="card">
          <Empty icon="folder" title="No study materials yet" sub={canUpload ? "Upload a text note, link or file to share with a class." : "Your teachers have not shared anything yet."} />
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3.5">
          {list.map((r) => (
            <div key={r.n.id} className="card p-4 flex flex-wrap gap-3.5 fade-up">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${r.n.type === "file" ? "bg-saffron-soft text-saffron-dark" : r.n.type === "link" ? "bg-info-soft text-info" : "bg-forest-soft text-forest"}`}>
                <Icon name={r.n.type === "file" ? "download" : r.n.type === "link" ? "link" : "file"} className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-ink leading-snug">{r.n.title}</div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {r.className && <Badge tone="green">{r.className}{r.section ? ` – ${r.section}` : ""}</Badge>}
                  {r.subject && <Badge tone="blue">{r.subject}</Badge>}
                  <Badge tone="gray">{r.n.type}</Badge>
                </div>
                {r.n.type === "text" && r.n.content && <p className="text-xs text-inksoft mt-2 line-clamp-3 whitespace-pre-line">{r.n.content}</p>}
                <div className="flex items-center justify-between mt-2.5">
                  <span className="text-[11px] text-muted">{r.by ?? "—"} · {fmtDate(r.n.createdAt)}</span>
                  <div className="flex items-center gap-2">
                    {r.n.url && (
                      <a href={r.n.url} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">
                        <Icon name={r.n.type === "file" ? "download" : "link"} className="w-3.5 h-3.5" />
                        {r.n.type === "file" ? (r.n.fileName ?? "Download") : "Open"}
                      </a>
                    )}
                    {r.n.type === "text" && r.n.content && <ReadNote content={r.n.content} />}
                    {(isAdmin || user.id === r.n.uploadedById) && (
                      <ConfirmButton action={deleteNote} icon="trash" title="Delete" message={`Delete “${r.n.title}”?`} confirmText="Delete" fields={[{ name: "id", value: String(r.n.id) }]} />
                    )}
                  </div>
                </div>

              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}


