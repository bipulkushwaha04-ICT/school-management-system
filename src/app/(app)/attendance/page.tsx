import Link from "next/link";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { students, enrollments, classes, sections, attendance, classSubjects, parentChildren, academicYears } from "@/db/schema";
import { requireUser, requireRole, logAudit } from "@/lib/auth";
import { currentSchoolId } from "@/lib/tenant";
import { flashTo } from "@/actions/auth";
import { attendancePct, fmtDate, todayStr, addDays, dateStr, getSchool } from "@/lib/grading";
import { PageHead, Badge, Donut, Icon, Empty, Field } from "@/components/ui";

export const dynamic = "force-dynamic";

/* ---------------------------------- Actions --------------------------------- */

export async function markAttendance(formData: FormData) {
  "use server";
  const user = await requireUser();
  if (user.role !== "teacher" && user.role !== "admin") {
    await flashTo("/dashboard", "You are not allowed to mark attendance.", true);
    return;
  }
  const schoolId = await currentSchoolId();
  const classId = Number(formData.get("classId"));
  const sectionId = formData.get("sectionId") ? Number(formData.get("sectionId")) : null;
  const date = String(formData.get("date") ?? "").slice(0, 10);
  if (!classId || !date) await flashTo("/attendance", "Select a class and date.", true);

  // teachers can only mark their assigned classes
  if (user.role === "teacher") {
    const mine = await db
      .select()
      .from(classSubjects)
      .where(and(eq(classSubjects.teacherId, user.teacherId!), eq(classSubjects.schoolId, schoolId)));
    if (!mine.some((m) => m.classId === classId)) {
      await flashTo("/attendance", "You can only mark attendance for your assigned classes.", true);
      return;
    }
  }

  const roster = await db
    .select({ id: enrollments.studentId })
    .from(enrollments)
    .where(
      sectionId
        ? and(eq(enrollments.classId, classId), eq(enrollments.sectionId, sectionId), eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId))
        : and(eq(enrollments.classId, classId), eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId)),
    );

  let n = 0;
  for (const r of roster) {
    const status = String(formData.get(`s${r.id}`) ?? "P");
    if (!["P", "A", "L", "LV"].includes(status)) continue;
    await db
      .insert(attendance)
      .values({ studentId: r.id, attDate: date, status, markedById: user.id, schoolId })
      .onConflictDoUpdate({
        target: [attendance.schoolId, attendance.studentId, attendance.attDate],
        set: { status, markedById: user.id },
      });
    n++;
  }
  await logAudit(user.id, "Saved attendance", "attendance", undefined, `${n} students on ${date}`);
  await flashTo(`/attendance?mode=mark&classId=${classId}&sectionId=${sectionId ?? ""}&date=${date}`, `Attendance saved for ${n} students on ${date}.`);
}

/* ----------------------------------- Page ----------------------------------- */

export default async function AttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const mode = sp.mode ? String(sp.mode) : user.role === "student" ? "mine" : user.role === "parent" ? "child" : "mark";

  if (user.role === "student") return <Mine studentId={user.studentId!} />;
  if (user.role === "parent") return <ChildView userId={user.id} initialChild={sp.child ? Number(sp.child) : null} />;

  if (mode === "report") return <Report searchParams={sp} />;
  return <Register mode={mode} classId={sp.classId ? Number(sp.classId) : null} sectionId={sp.sectionId ? Number(sp.sectionId) : null} date={sp.date ? String(sp.date) : todayStr()} user={user} />;
}

/* ------------------------------ Teacher register ----------------------------- */

async function Register({ classId, sectionId, date, user }: { classId: number | null; sectionId: number | null; date: string; mode: string; user: any }) {
  const schoolId = await currentSchoolId();
  const isAdmin = user.role === "admin";
  const [allClasses, allSections, myClasses] = await Promise.all([
    db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(classes.sortOrder),
    db.select().from(sections).where(eq(sections.schoolId, schoolId)).orderBy(sections.name),
    user.role === "teacher"
      ? db
          .select({ classId: classSubjects.classId, class: classes.name })
          .from(classSubjects)
          .innerJoin(classes, eq(classes.id, classSubjects.classId))
          .where(and(eq(classSubjects.teacherId, user.teacherId), eq(classSubjects.schoolId, schoolId)))
      : Promise.resolve([]),
  ]);

  const availableClasses = isAdmin ? allClasses : myClasses.map((m) => allClasses.find((c) => c.id === m.classId)!).filter(Boolean);
  const effClass = classId ?? availableClasses[0]?.id ?? null;
  const effSections = allSections.filter((s) => s.classId === effClass);
  const effSection = sectionId ?? effSections[0]?.id ?? null;

  const [existing, roster] = await Promise.all([
    db.select().from(attendance).where(and(eq(attendance.attDate, date), eq(attendance.schoolId, schoolId))),
    db
      .select({ student: students, rollNo: enrollments.rollNo })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(
        and(
          eq(enrollments.classId, effClass ?? -1),
          effSection ? eq(enrollments.sectionId, effSection) : sql`true`,
          eq(enrollments.status, "active"),
          eq(enrollments.schoolId, schoolId),
        ),
      )
      .orderBy(enrollments.rollNo),
  ]);
  const existingMap = new Map(existing.map((e) => [e.studentId, e.status]));

  return (
    <>
      <PageHead title="Attendance" sub="Mark the daily register — Present, Late, Absent or Leave">
        {isAdmin && (
          <Link href="/attendance?mode=report" className="btn-ghost">
            <Icon name="chart" className="w-4 h-4" /> Attendance report
          </Link>
        )}
      </PageHead>

      <form method="get" action="/attendance" className="card p-3.5 mb-4 grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <input type="hidden" name="mode" value="mark" />
        <Field label="Class">
          <select name="classId" defaultValue={effClass ?? ""} className="inp">
            {availableClasses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Section">
          <select name="sectionId" defaultValue={effSection ?? ""} className="inp">
            <option value="">Whole class</option>
            {effSections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input name="date" type="date" defaultValue={date} max={todayStr()} className="inp" />
        </Field>
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full">
            <Icon name="check" className="w-4 h-4" /> Load register
          </button>
        </div>
      </form>

      <div className="card overflow-hidden">
        {roster.length === 0 ? (
          <Empty icon="clipboard" title="No students in this section" sub="Pick a class and section with enrolled students." />
        ) : (
          <form action={markAttendance}>
            <input type="hidden" name="classId" value={effClass} />
            <input type="hidden" name="sectionId" value={effSection ?? ""} />
            <input type="hidden" name="date" value={date} />
            <div className="overflow-x-auto">
              <table className="tbl min-w-[560px]">
                <thead>
                  <tr><th>Roll</th><th>Student</th><th className="text-center">Present</th><th className="text-center">Late</th><th className="text-center">Absent</th><th className="text-center">Leave</th></tr>
                </thead>
                <tbody>
                  {roster.map((r) => {
                    const cur = existingMap.get(r.student.id) ?? "P";
                    return (
                      <tr key={r.student.id}>
                        <td className="text-muted">{r.rollNo ?? "—"}</td>
                        <td className="font-semibold">{r.student.name}</td>
                        {["P", "L", "A", "LV"].map((s) => (
                          <td key={s} className="text-center">
                            <input
                              type="radio"
                              name={`s${r.student.id}`}
                              value={s}
                              defaultChecked={cur === s}
                              className={`w-4 h-4 accent-forest cursor-pointer`}
                              style={{ accentColor: s === "P" ? "#1d5c3f" : s === "L" ? "#d9942a" : s === "A" ? "#b23a2f" : "#2e6f8e" }}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3.5 border-t border-line flex items-center justify-between flex-wrap gap-2">
              <div className="flex gap-3 text-[11px] font-bold">
                <span className="text-forest">● Present</span>
                <span className="text-saffron-dark">● Late</span>
                <span className="text-danger">● Absent</span>
                <span className="text-info">● Leave</span>
              </div>
              <button className="btn-primary">
                <Icon name="check" className="w-4 h-4" /> Save attendance ({roster.length} students)
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

/* ---------------------------------- Report ---------------------------------- */

async function Report({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireRole("admin");
  const schoolId = await currentSchoolId();
  const [allClasses, allSections, activeYear] = await Promise.all([
    db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(classes.sortOrder),
    db.select().from(sections).where(eq(sections.schoolId, schoolId)).orderBy(sections.name),
    db.select().from(academicYears).where(and(eq(academicYears.status, "active"), eq(academicYears.schoolId, schoolId))).limit(1),
  ]);
  const effClass = searchParams.classId ? Number(searchParams.classId) : allClasses[allClasses.length - 1]?.id ?? null;
  const effSections = allSections.filter((s) => s.classId === effClass);
  const effSection = searchParams.sectionId ? Number(searchParams.sectionId) : effSections[0]?.id ?? null;

  const roster = await db
    .select({ student: students, rollNo: enrollments.rollNo })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(and(eq(enrollments.classId, effClass ?? -1), effSection ? eq(enrollments.sectionId, effSection) : sql`true`, eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId)))
    .orderBy(enrollments.rollNo);

  const fromParam = String(searchParams.from ?? "");
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromParam)
    ? new Date(`${fromParam}T00:00:00`)
    : new Date(`${addDays(new Date(), -29)}T00:00:00`);
  const from = dateStr(fromDate);
  const to = todayStr();
  const rows = await Promise.all(
    roster.map(async (r) => {
      const p = await attendancePct(r.student.id, fromDate, new Date(to), schoolId);
      return { r, p };
    }),
  );
  const classPct = rows.length > 0 ? Math.round((rows.reduce((a, x) => a + x.p.pct, 0) / rows.length) * 10) / 10 : 0;

  return (
    <>
      <PageHead title="Attendance Report" sub="Last 30 days, per student and per class">
        <Link href="/attendance?mode=mark" className="btn-ghost"><Icon name="back" className="w-4 h-4" /> Back to register</Link>
      </PageHead>

      <form className="card p-3.5 mb-4 grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <input type="hidden" name="mode" value="report" />
        <Field label="Class">
          <select name="classId" defaultValue={effClass} className="inp">
            {allClasses.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Section">
          <select name="sectionId" defaultValue={effSection ?? ""} className="inp">
            <option value="">Whole class</option>
            {effSections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" name="from" defaultValue={from} className="inp" />
        </Field>
        <div className="flex items-end gap-2">
          <button className="btn-primary flex-1">Apply</button>
          <a href={`/api/data?op=export&type=attendance&classId=${effClass}&sectionId=${effSection ?? ""}`} className="btn-ghost">
            <Icon name="download" className="w-4 h-4" /> CSV
          </a>
        </div>
      </form>

      <div className="grid grid-cols-3 gap-3.5 mb-4">
        <div className="card p-4 text-center">
          <div className="text-2xl font-extrabold text-forest">{classPct}%</div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted mt-1">Class average (30d)</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-extrabold text-ink">{rows.filter((x) => x.p.pct >= 75).length}</div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted mt-1">Students ≥ 75%</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-extrabold text-danger">{rows.filter((x) => x.p.pct < 75).length}</div>
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted mt-1">Below 75% (at risk)</div>
        </div>
      </div>

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <Empty icon="chart" title="No students" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl min-w-[640px]">
              <thead>
                <tr><th>Roll</th><th>Student</th><th>Present</th><th>Late</th><th>Absent</th><th>Leave</th><th>Percentage</th><th>Status</th></tr>
              </thead>
              <tbody>
                {rows.map(({ r, p }) => (
                  <tr key={r.student.id}>
                    <td className="text-muted">{r.rollNo ?? "—"}</td>
                    <td className="font-semibold">{r.student.name}</td>
                    <td>{p.present}</td>
                    <td>{p.late}</td>
                    <td>{p.absent}</td>
                    <td>{p.leave}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-1.5 rounded-full bg-linesoft overflow-hidden">
                          <div className={`h-full rounded-full ${p.pct >= 75 ? "bg-forest" : "bg-danger"}`} style={{ width: `${p.pct}%` }} />
                        </div>
                        <span className={`text-sm font-bold ${p.pct >= 75 ? "text-forest" : "text-danger"}`}>{p.pct}%</span>
                      </div>
                    </td>
                    <td>{p.pct >= 75 ? <Badge tone="green">OK</Badge> : <Badge tone="red">At risk</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* --------------------------------- Student ---------------------------------- */

async function Mine({ studentId }: { studentId: number }) {
  const schoolId = await currentSchoolId();
  const att = await attendancePct(studentId, undefined, undefined, schoolId);
  const school = await getSchool(schoolId);
  const recent = await db.select().from(attendance).where(and(eq(attendance.studentId, studentId), eq(attendance.schoolId, schoolId))).orderBy(desc(attendance.attDate)).limit(60);

  return (
    <>
      <PageHead title="My Attendance" sub={`Minimum required: ${school.minAttendance}%`} />
      <div className="grid md:grid-cols-3 gap-3.5">
        <div className="card p-5 flex flex-col items-center">
          <Donut value={att.pct} label="present" size={130} color={att.pct >= school.minAttendance ? "#1d5c3f" : "#b23a2f"} />
          <p className="text-xs text-muted mt-3 text-center">
            {att.present} present · {att.absent} absent · {att.late} late · {att.leave} on leave
          </p>
        </div>
        <div className="card overflow-hidden md:col-span-2">
          <div className="px-5 pt-4 pb-2 flex items-center justify-between">
            <h3 className="font-bold text-sm text-ink">Recent entries</h3>
            <Link href={`/api/data?op=export&type=attendance&student=${studentId}`} className="text-xs font-bold text-forest hover:underline">Download CSV</Link>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Day</th><th>Status</th></tr>
              </thead>
              <tbody>
                {recent.map((a) => (
                  <tr key={a.id}>
                    <td>{fmtDate(a.attDate)}</td>
                    <td className="text-muted">{new Date(a.attDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" })}</td>
                    <td>
                      <Badge tone={a.status === "P" ? "green" : a.status === "A" ? "red" : a.status === "L" ? "amber" : "blue"}>
                        {a.status === "P" ? "Present" : a.status === "A" ? "Absent" : a.status === "L" ? "Late" : "On leave"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------- Parent ---------------------------------- */

async function ChildView({ userId, initialChild }: { userId: number; initialChild: number | null }) {
  const schoolId = await currentSchoolId();
  const children = await db
    .select({ id: students.id, name: students.name })
    .from(parentChildren)
    .innerJoin(students, eq(students.id, parentChildren.studentId))
    .where(and(eq(parentChildren.userId, userId), eq(parentChildren.schoolId, schoolId)));
  if (children.length === 0) {
    return (
      <>
        <PageHead title="Attendance" sub="My children" />
        <div className="card">
          <Empty icon="users" title="No children linked" sub="Contact the school office to link your child(ren)." />
        </div>
      </>
    );
  }
  const effChild = initialChild && children.find((c) => c.id === initialChild) ? initialChild : children[0].id;

  return (
    <>
      <PageHead title="Attendance" sub="My children">
        <div className="flex gap-1.5">
          {children.map((c) => (
            <Link key={c.id} href={`/attendance?mode=child&child=${c.id}`} className={`btn-sm ${effChild === c.id ? "btn-primary" : "btn-ghost"}`}>
              {c.name}
            </Link>
          ))}
        </div>
      </PageHead>
      <ChildAttendance studentId={effChild} />
    </>
  );
}

async function ChildAttendance({ studentId }: { studentId: number }) {
  const schoolId = await currentSchoolId();
  const [child, school] = await Promise.all([
    db.select().from(students).where(and(eq(students.id, studentId), eq(students.schoolId, schoolId))).limit(1),
    getSchool(schoolId),
  ]);
  const att = await attendancePct(studentId, undefined, undefined, schoolId);
  const recent = await db.select().from(attendance).where(and(eq(attendance.studentId, studentId), eq(attendance.schoolId, schoolId))).orderBy(desc(attendance.attDate)).limit(30);
  return (
    <div className="grid md:grid-cols-3 gap-3.5">
      <div className="card p-5 flex flex-col items-center">
        <div className="font-bold text-ink mb-3">{child[0]?.name}</div>
        <Donut value={att.pct} label="present" size={130} color={att.pct >= school.minAttendance ? "#1d5c3f" : "#b23a2f"} />
        <p className="text-xs text-muted mt-3 text-center">{att.present} present · {att.absent} absent</p>
      </div>
      <div className="card overflow-hidden md:col-span-2">
        <div className="px-5 pt-4 pb-2">
          <h3 className="font-bold text-sm text-ink">Last 30 entries</h3>
        </div>
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr><th>Date</th><th>Day</th><th>Status</th></tr>
            </thead>
            <tbody>
              {recent.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDate(a.attDate)}</td>
                  <td className="text-muted">{new Date(a.attDate + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" })}</td>
                  <td>
                    <Badge tone={a.status === "P" ? "green" : a.status === "A" ? "red" : a.status === "L" ? "amber" : "blue"}>
                      {a.status === "P" ? "Present" : a.status === "A" ? "Absent" : a.status === "L" ? "Late" : "On leave"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
