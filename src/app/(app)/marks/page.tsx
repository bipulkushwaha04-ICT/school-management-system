
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import { examinations, examSubjects, classes, subjects, students, enrollments, classSubjects, marks, academicYears } from "@/db/schema";
import { requireUser, requireRole, logAudit } from "@/lib/auth";
import { currentSchoolId } from "@/lib/tenant";
import { flashTo } from "@/actions/auth";
import { fmtDate } from "@/lib/grading";
import { PageHead, Badge, Icon, Empty, Field } from "@/components/ui";
import MarksEntryTable from "./marks-entry-table";
import MarksSelection from "./marks-selection";

export const dynamic = "force-dynamic";

/* ---------------------------------- Actions --------------------------------- */

export async function submitMarks(formData: FormData) {
  "use server";
  const user = await requireUser();
  if (user.role === "student" || user.role === "parent") await flashTo("/dashboard", "Not permitted.", true);
  const schoolId = await currentSchoolId();

  const examSubjectId = Number(formData.get("examSubjectId"));
  if (!Number.isInteger(examSubjectId) || examSubjectId <= 0) await flashTo("/marks", "Select a subject first.", true);

  const [sub] = await db
    .select({ e: examinations, exam: examSubjects })
    .from(examSubjects)
    .innerJoin(examinations, and(eq(examinations.id, examSubjects.examId), eq(examinations.schoolId, schoolId)))
    .where(and(eq(examSubjects.id, examSubjectId), eq(examSubjects.schoolId, schoolId)))
    .limit(1);

  if (!sub) await flashTo("/marks", "Select a subject first.", true);
  if (sub.e.status === "published") await flashTo("/marks", "This examination is published and locked. An administrator must reopen it first.", true);

  // teacher permission: must be assigned to this class+subject
  if (user.role === "teacher") {
    if (!user.teacherId) await flashTo("/marks", "Your account is not linked to a teacher record.", true);
    const [a] = await db
      .select()
      .from(classSubjects)
      .where(and(eq(classSubjects.classId, sub.exam.classId), eq(classSubjects.subjectId, sub.exam.subjectId), eq(classSubjects.teacherId, user.teacherId!), eq(classSubjects.schoolId, schoolId)))
      .limit(1);

    if (!a) await flashTo("/marks", "You are not assigned to this class & subject.", true);
  }

  const allowedRows = sub.exam.classId === 0
    ? await db.select({ studentId: enrollments.studentId }).from(enrollments).where(and(eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId)))
    : await db
        .select({ studentId: enrollments.studentId })
        .from(enrollments)
        .where(and(eq(enrollments.classId, sub.exam.classId), eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId)));
  const allowedStudentIds = new Set(allowedRows.map((r) => r.studentId));

  const theoryFull = sub.exam.fullMarks - sub.exam.practicalMarks;
  const practicalFull = sub.exam.practicalMarks;

  const back = `/marks?exam=${sub.e.id}&examSubjectId=${examSubjectId}`;
  const parseMark = (raw: FormDataEntryValue | null): number | null | typeof NaN => {
    const text = raw == null ? "" : String(raw).trim();
    if (text === "") return null;
    const n = Number(text);
    return Number.isFinite(n) ? Math.round(n) : Number.NaN;
  };

  const rowsToSave: { examSubjectId: number; studentId: number; theory: number; practical: number; schoolId: number }[] = [];
  const problems: string[] = [];

  for (const key of new Set(formData.keys())) {
    if (!/^t\d+$/.test(key)) continue;

    const studentId = Number(key.slice(1));
    if (!allowedStudentIds.has(studentId)) {
      problems.push(`student #${studentId} is not in this class`);
      continue;
    }

    const t = parseMark(formData.get(key));
    const p = practicalFull > 0 ? parseMark(formData.get(`p${studentId}`)) : 0;

    // A completely blank row means "not entered yet": leave it untouched.
    if (t === null && (p === null || practicalFull === 0)) continue;

    if (t === null || Number.isNaN(t) || t < 0 || t > theoryFull) {
      problems.push(`theory for student #${studentId} must be 0 to ${theoryFull}`);
      continue;
    }
    const practical = p ?? 0;
    if (Number.isNaN(practical) || practical < 0 || practical > practicalFull) {
      problems.push(`practical for student #${studentId} must be 0 to ${practicalFull}`);
      continue;
    }

    rowsToSave.push({ examSubjectId, studentId, theory: t, practical, schoolId });
  }

  // All-or-nothing: never save half a sheet when some entries are wrong.
  if (problems.length > 0) {
    await flashTo(back, `Nothing was saved. Fix ${problems.length} entr${problems.length === 1 ? "y" : "ies"}: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? "…" : ""}.`, true);
    return;
  }

  if (rowsToSave.length === 0) {
    await flashTo(back, "No marks were entered.", true);
    return;
  }

  await db
    .insert(marks)
    .values(rowsToSave)
    .onConflictDoUpdate({
      target: [marks.schoolId, marks.examSubjectId, marks.studentId],
      set: { theory: sql`excluded.theory`, practical: sql`excluded.practical` },
    });
  const saved = rowsToSave.length;

  const [examRow] = await db.select().from(examinations).where(and(eq(examinations.id, sub.e.id), eq(examinations.schoolId, schoolId))).limit(1);

  await logAudit(user.id, "Entered marks", "marks", examSubjectId, `${saved} student(s) — ${examRow?.name}`);

  await flashTo(back, `Marks saved for ${saved} student(s).`);
}

/* ----------------------------------- Page ----------------------------------- */

export default async function MarksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const schoolId = await currentSchoolId();

  if (user.role === "student" || user.role === "parent") {
    return (
      <>
        <PageHead title="Mark Entry" sub="Restricted" />
        <div className="card">
          <Empty icon="lock" title="Not available for your account" sub="Mark entry is reserved for teachers and administrators." />
        </div>
      </>
    );
  }

  const isAdmin = user.role === "admin";
  const sp = await searchParams;

  const exams = await db
    .select({
      id: examinations.id,
      name: examinations.name,
      status: examinations.status,
      startDate: examinations.startDate,
      year: sql<string>`academic_years.name`
    })
    .from(examinations)
    .innerJoin(academicYears, eq(academicYears.id, examinations.academicYearId))
    .where(and(sql`${examinations.status} != 'published'`, eq(examinations.schoolId, schoolId)))
    .orderBy(examinations.id);

  const examId = sp.exam ? Number(sp.exam) : exams[0]?.id ?? null;
  const activeExam = exams.find((e) => e.id === examId);

  // subject entries for the exam (restricted for teachers)
  let subRows: {
    id: number;
    examId: number;
    classId: number;
    subjectId: number;
    className: string;
    subjectName: string;
    fullMarks: number;
    practicalMarks: number;
    passMarks: number;
  }[] = [];

  if (activeExam) {
    const base = await db
      .select({
        id: examSubjects.id,
        examId: examSubjects.examId,
        classId: examSubjects.classId,
        subjectId: examSubjects.subjectId,
        className: classes.name,
        subjectName: subjects.name,
        fullMarks: examSubjects.fullMarks,
        practicalMarks: examSubjects.practicalMarks,
        passMarks: examSubjects.passMarks
      })
      .from(examSubjects)
      .innerJoin(classes, eq(classes.id, examSubjects.classId))
      .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
      .where(and(eq(examSubjects.examId, activeExam.id), eq(examSubjects.schoolId, schoolId)))
      .orderBy(classes.sortOrder, subjects.name);

    if (isAdmin) {
      subRows = base.map((b) => ({
        id: b.id,
        examId: b.examId,
        classId: b.classId,
        subjectId: b.subjectId,
        className: b.className,
        subjectName: b.subjectName,
        fullMarks: b.fullMarks,
        practicalMarks: b.practicalMarks,
        passMarks: b.passMarks
      }));
    } else {
      const assigned = await db.select().from(classSubjects).where(and(eq(classSubjects.teacherId, user.teacherId!), eq(classSubjects.schoolId, schoolId)));
      const key = new Set(assigned.map((a) => `${a.classId}:${a.subjectId}`));

      subRows = base
        .filter((b) => key.has(`${b.classId}:${b.subjectId}`))
        .map((b) => ({
          id: b.id,
          examId: b.examId,
          classId: b.classId,
          subjectId: b.subjectId,
          className: b.className,
          subjectName: b.subjectName,
          fullMarks: b.fullMarks,
          practicalMarks: b.practicalMarks,
          passMarks: b.passMarks
        }));
    }
  }

  const requestedSubId = sp.examSubjectId ? Number(sp.examSubjectId) : null;
  const selSubId = subRows.some((s) => s.id === requestedSubId) ? requestedSubId : subRows[0]?.id ?? null;
  const selSub = subRows.find((s) => s.id === selSubId);

  let roster: { student: any; rollNo: number | null }[] = [];
  let existing: Record<number, { theory: number; practical: number }> = {};

  if (selSub && activeExam) {
    const [cRow] = await db.select().from(examSubjects).where(and(eq(examSubjects.id, selSub.id), eq(examSubjects.schoolId, schoolId))).limit(1);

    if (cRow) {
      roster = await db
        .select({ student: students, rollNo: enrollments.rollNo })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(and(eq(enrollments.classId, cRow.classId), eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId)))
        .orderBy(enrollments.rollNo);

      const m = await db
        .select({
          studentId: marks.studentId,
          theory: marks.theory,
          practical: marks.practical
        })
        .from(marks)
        .where(and(eq(marks.examSubjectId, selSub.id), eq(marks.schoolId, schoolId)));

      existing = Object.fromEntries(m.map((x) => [
        x.studentId,
        { theory: x.theory, practical: x.practical }
      ]));
    }
  }

  return (
    <>
      <PageHead title="Mark Entry" sub="Enter theory and practical marks — validated against full marks" />

      <MarksSelection
        exams={exams}
        rows={subRows}
        activeExamId={activeExam?.id ?? null}
        selectedSubjectId={selSubId}
      />

      {!activeExam ? (
        <div className="card">
          <Empty icon="pen" title="No open examinations" sub="Create an examination and configure its subjects first." />
        </div>
      ) : subRows.length === 0 ? (
        <div className="card">
          <Empty icon="book" title="No subjects for this examination" sub={isAdmin ? "Configure subjects in Examinations." : "You have no assigned subjects in this examination."} />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-4 sm:px-5 py-5 border-b border-line">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge tone="green">MARK ENTRY</Badge>
                  <span className="text-xs text-muted">{activeExam.name}</span>
                </div>
                <h3 className="text-xl font-extrabold text-ink">
                  {selSub?.className} · {selSub?.subjectName}
                </h3>
                <p className="text-xs text-muted mt-1">
                  Enter and review student marks for this subject.
                </p>
              </div>

              <a href={`/results?exam=${activeExam.id}`} className="btn-ghost btn-sm self-start">
                <Icon name="file" className="w-3.5 h-3.5" />
                View results
              </a>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-5">
              <div className="rounded-lg bg-forest-mist border border-line p-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Theory</p>
                <p className="text-lg font-extrabold text-ink mt-1">
                  {selSub!.fullMarks - selSub!.practicalMarks}
                  <span className="text-xs font-medium text-muted ml-1">marks</span>
                </p>
              </div>
              <div className="rounded-lg bg-forest-mist border border-line p-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Practical</p>
                <p className="text-lg font-extrabold text-ink mt-1">
                  {selSub!.practicalMarks}
                  <span className="text-xs font-medium text-muted ml-1">marks</span>
                </p>
              </div>
              <div className="rounded-lg bg-forest-mist border border-line p-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Full marks</p>
                <p className="text-lg font-extrabold text-forest mt-1">{selSub!.fullMarks}</p>
              </div>
              <div className="rounded-lg bg-saffron-soft border border-saffron/20 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-saffron-dark">Pass marks</p>
                <p className="text-lg font-extrabold text-saffron-dark mt-1">{selSub!.passMarks}</p>
              </div>
            </div>
          </div>

          {roster.length === 0 ? (
            <Empty icon="cap" title="No active students in this class" />
          ) : (
            <MarksEntryTable
              key={selSubId}
              examSubjectId={selSubId!}
              theoryFull={selSub!.fullMarks - selSub!.practicalMarks}
              practicalFull={selSub!.practicalMarks}
              rows={roster.map((r) => ({
                studentId: r.student.id,
                name: r.student.name,
                rollNo: r.rollNo,
                theory: existing[r.student.id]?.theory ?? null,
                practical: existing[r.student.id]?.practical ?? null,
              }))}
              action={submitMarks}
            />
          )}
        </div>
      )}
    </>
  );
}





