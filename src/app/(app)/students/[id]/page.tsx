import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq, and, desc, sql, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { students, enrollments, classes, sections, academicYears, attendance, examinations, examSubjects, notes, parentChildren, subjects, feeInvoices, feePayments } from "@/db/schema";
import { requireUser, requireRole, logAudit } from "@/lib/auth";
import { currentSchoolId } from "@/lib/tenant";
import { flashTo } from "@/actions/auth";
import { attendancePct, computeClassResults, fmtDate, getScale } from "@/lib/grading";
import { PageHead, Badge, Donut, Icon, Empty, FormModal, ModalCancel, ConfirmButton } from "@/components/ui";
import { StudentForm, deleteStudent } from "../page";

export const dynamic = "force-dynamic";

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const studentId = Number(id);
  const user = await requireUser();
  const schoolId = await currentSchoolId();

  if (user.role === "student" && user.studentId !== studentId) redirect("/dashboard");
  if (user.role === "parent") {
    const link = await db.select().from(parentChildren).where(and(eq(parentChildren.userId, user.id), eq(parentChildren.studentId, studentId), eq(parentChildren.schoolId, schoolId))).limit(1);
    if (link.length === 0) redirect("/dashboard");
  }
  const canEdit = user.role === "admin";

  const [studentRow] = await db.select().from(students).where(and(eq(students.id, studentId), isNull(students.deletedAt), eq(students.schoolId, schoolId))).limit(1);
  if (!studentRow) notFound();
  const st = studentRow;

  const [enrollmentsAll, classesAll, sectionsAll, notesList, attRecent] = await Promise.all([
    db
      .select({
        id: enrollments.id,
        className: classes.name,
        classId: enrollments.classId,
        section: sections.name,
        sectionId: enrollments.sectionId,
        rollNo: enrollments.rollNo,
        year: sql<string>`academic_years.name`,
        status: enrollments.status,
        admissionDate: enrollments.admissionDate,
      })
      .from(enrollments)
      .innerJoin(classes, and(eq(classes.id, enrollments.classId), eq(classes.schoolId, schoolId)))
      .leftJoin(sections, and(eq(sections.id, enrollments.sectionId), eq(sections.schoolId, schoolId)))
      .innerJoin(academicYears, and(eq(academicYears.id, enrollments.academicYearId), eq(academicYears.schoolId, schoolId)))
      .where(and(eq(enrollments.studentId, studentId), eq(enrollments.schoolId, schoolId)))
      .orderBy(desc(enrollments.createdAt)),
    db.select().from(classes).where(eq(classes.schoolId, schoolId)).orderBy(classes.sortOrder),
    db.select().from(sections).where(eq(sections.schoolId, schoolId)),
    db
      .select({ title: notes.title, subject: subjects.name, created: notes.createdAt, type: notes.type, url: notes.url, fileName: notes.fileName, noteId: notes.id })
      .from(notes)
      .leftJoin(subjects, and(eq(subjects.id, notes.subjectId), eq(subjects.schoolId, schoolId)))
      .where(and(sql`${notes.classId} in (select class_id from enrollments where student_id = ${studentId} and school_id = ${schoolId} and status = 'active')`, eq(notes.schoolId, schoolId)))
      .orderBy(desc(notes.createdAt))
      .limit(5),
    db.select().from(attendance).where(and(eq(attendance.studentId, studentId), eq(attendance.schoolId, schoolId))).orderBy(desc(attendance.attDate)).limit(14),
  ]);

  const active = enrollmentsAll.find((e) => e.status === "active");
  const att = await attendancePct(studentId, undefined, undefined, schoolId);
  const scale = await getScale(schoolId);

  // published exams for the student's active class
  let resultRows: { examName: string; endDate: string; examId: number; gpa: string; pct: number | null; status: string }[] = [];
  if (active) {
    const activeClassId = (await db.select().from(enrollments).where(and(eq(enrollments.studentId, studentId), eq(enrollments.status, "active"), eq(enrollments.schoolId, schoolId))).limit(1))[0]?.classId;
    if (activeClassId) {
      const exams = await db
        .select({ name: examinations.name, id: examinations.id, endDate: examinations.endDate })
        .from(examinations)
        .where(and(eq(examinations.status, "published"), sql`${examinations.id} in (select exam_id from exam_subjects where class_id = ${activeClassId} and school_id = ${schoolId})`, eq(examinations.schoolId, schoolId)))
        .orderBy(desc(examinations.endDate))
        .limit(6);
      for (const e of exams) {
        const res = await computeClassResults(e.id, activeClassId, scale, schoolId);
        const mine = res.find((r) => r.studentId === studentId);
        if (mine) {
          resultRows.push({ examName: e.name, endDate: e.endDate!, examId: e.id, gpa: mine.gpaDisplay, pct: mine.pct, status: mine.result });
        }
      }
    }
  }

  const ageResult = st.dob
    ? await db.execute(sql<{ age: number }>`SELECT EXTRACT(YEAR FROM age(CURRENT_DATE, ${st.dob}::date))::int AS age`)
    : null;
  const rawDobAge = ageResult?.rows[0]?.age;
  const dobAge: number | null =
    rawDobAge == null ? null : Number(rawDobAge);

  // Student fee summary and payment history
  const feeInvoiceRows = await db
    .select()
    .from(feeInvoices)
    .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.schoolId, schoolId)))
    .orderBy(desc(feeInvoices.createdAt));

  const feeInvoiceIds = feeInvoiceRows.map((invoice) => invoice.id);

  const feePaymentRows = feeInvoiceIds.length
    ? await db
        .select()
        .from(feePayments)
        .where(and(inArray(feePayments.invoiceId, feeInvoiceIds), eq(feePayments.schoolId, schoolId)))
        .orderBy(desc(feePayments.paidAt))
    : [];

  const paidByInvoice = new Map<number, number>();

  for (const payment of feePaymentRows) {
    paidByInvoice.set(
      payment.invoiceId,
      (paidByInvoice.get(payment.invoiceId) ?? 0) + payment.amountPaisa,
    );
  }

  const totalBilledPaisa = feeInvoiceRows.reduce(
    (sum, invoice) => sum + invoice.totalPaisa,
    0,
  );

  const totalPaidPaisa = feePaymentRows.reduce(
    (sum, payment) => sum + payment.amountPaisa,
    0,
  );

  const totalDuePaisa = feeInvoiceRows.reduce(
    (sum, invoice) =>
      sum + Math.max(0, invoice.totalPaisa - (paidByInvoice.get(invoice.id) ?? 0)),
    0,
  );

  const formatFeeAmount = (paisa: number) =>
    new Intl.NumberFormat("en-NP", {
      style: "currency",
      currency: "NPR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(paisa / 100);
  return (
    <>
      <Link href={user.role === "admin" ? "/students" : "/dashboard"} className="inline-flex items-center gap-1.5 text-sm font-semibold text-inksoft hover:text-forest mb-4">
        <Icon name="back" className="w-4 h-4" />
        {user.role === "admin" ? "All students" : "Dashboard"}
      </Link>

      <div className="card p-5 mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <span className="w-16 h-16 rounded-2xl bg-forest text-white flex items-center justify-center text-2xl font-extrabold shrink-0">{st.name[0]}</span>
          <div className="flex-1 min-w-[220px]">
            <h1 className="font-display text-2xl font-bold text-ink">{st.name}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Badge tone="green">{st.admissionNo}</Badge>
              {active && <Badge tone="blue">{active.className} – {active.section} · Roll {active.rollNo ?? "—"}</Badge>}
              <Badge tone="gray">{st.gender ?? "—"}</Badge>
              {dobAge != null && <Badge tone="gray">{dobAge} yrs</Badge>}
            </div>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              <FormModal title={`Edit — ${st.name}`} btnClass="btn-ghost" icon="edit" label="Edit" wide>
                <StudentForm classes={classesAll} sections={sectionsAll} student={{ ...st, admissionDate: active?.admissionDate }} classId={active?.classId ?? null} sectionId={active?.sectionId ?? null} rollNo={active?.rollNo ?? null} />
              </FormModal>
              <ConfirmButton
                action={deleteStudent}
                icon="trash"
                label="Remove"
                className="btn-danger"
                message={`Remove ${st.name} from active records? Academic history will be preserved.`}
                confirmText="Remove"
                fields={[{ name: "id", value: String(st.id) }]}
              />
            </div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-3.5">
        <div className="card p-5">
          <h3 className="font-bold text-sm text-ink mb-3">Personal information</h3>
          <dl className="space-y-2.5 text-sm">
            {[
              ["Date of birth", fmtDate(st.dob)],
              ["Age", dobAge != null ? `${dobAge} years` : "—"],
              ["Blood group", st.bloodGroup ?? "—"],
              ["Nationality", st.nationality ?? "—"],
              ["Contact", st.contact ?? "—"],
              ["Email", st.email ?? "—"],
              ["Address", st.address ?? "—"],
              ["Previous school", st.previousSchool ?? "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd className="font-semibold text-right">{v}</dd>
              </div>
            ))}
          </dl>
          <h3 className="font-bold text-sm text-ink mt-5 mb-3 border-t border-linesoft pt-4">Family & guardian</h3>
          <dl className="space-y-2.5 text-sm">
            {[
              ["Father", st.fatherName ?? "—"],
              ["Mother", st.motherName ?? "—"],
              ["Guardian", st.guardianName ?? "—"],
              ["Guardian contact", st.guardianContact ?? "—"],
              ["Occupation", st.guardianOccupation ?? "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd className="font-semibold text-right">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="card p-5">
          <h3 className="font-bold text-sm text-ink mb-4">Attendance</h3>
          <div className="flex justify-center mb-4">
            <Donut value={att.pct} label="present" size={116} color={att.pct >= 75 ? "#1d5c3f" : "#b23a2f"} />
          </div>
          <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
            {[
              { l: "Present", v: att.present, c: "text-forest" },
              { l: "Late", v: att.late, c: "text-saffron-dark" },
              { l: "Absent", v: att.absent, c: "text-danger" },
              { l: "Leave", v: att.leave, c: "text-info" },
            ].map((x) => (
              <div key={x.l} className="rounded-lg bg-forest-mist/70 py-1.5">
                <div className={`font-extrabold ${x.c}`}>{x.v}</div>
                <div className="text-[10px] font-bold uppercase text-muted">{x.l}</div>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted mb-2">Last 14 entries</div>
            <div className="flex flex-wrap gap-1.5">
              {attRecent.length === 0 && <span className="text-xs text-muted">No entries yet</span>}
              {attRecent.map((a) => (
                <span
                  key={a.id}
                  title={fmtDate(a.attDate)}
                  className={`w-7 h-7 rounded-md text-[10px] font-extrabold flex items-center justify-center ${
                    a.status === "P" ? "bg-forest text-white" : a.status === "A" ? "bg-danger text-white" : a.status === "L" ? "bg-saffron text-white" : "bg-info text-white"
                  }`}
                >
                  {a.status}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="card p-5 flex flex-col">
          <h3 className="font-bold text-sm text-ink mb-3">Academic history</h3>
          {enrollmentsAll.length === 0 ? (
            <Empty icon="calendar" title="No enrolments" />
          ) : (
            <ul className="space-y-2">
              {enrollmentsAll.map((e) => (
                <li key={e.id} className="flex items-center gap-3 rounded-lg border border-linesoft px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold">{e.className} – {e.section}</div>
                    <div className="text-[11px] text-muted">Roll {e.rollNo ?? "—"} · {e.year}</div>
                  </div>
                  <Badge tone={e.status === "active" ? "green" : e.status === "promoted" ? "blue" : "gray"}>{e.status}</Badge>
                </li>
              ))}
            </ul>
          )}
          <h3 className="font-bold text-sm text-ink mt-5 mb-3">Study materials</h3>
          {(notesList as any[]).length === 0 ? (
            <Empty icon="folder" title="Nothing assigned yet" />
          ) : (
            <ul className="space-y-2">
              {(notesList as any[]).map((nt: any) => (
                <li key={nt.noteId} className="flex items-center gap-2.5">
                  <Icon name="file" className="w-4 h-4 text-forest shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold truncate">{nt.title}</div>
                    <div className="text-[11px] text-muted">{nt.subject ?? "General"} · {fmtDate(nt.created)}</div>
                  </div>
                  {nt.url && (
                    <a href={nt.url} target="_blank" rel="noreferrer" className="text-xs font-bold text-forest hover:underline">
                      Open
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card overflow-hidden mt-3.5">
        <div className="px-5 pt-4 pb-1 flex items-center justify-between">
          <h3 className="font-bold text-sm text-ink">Examination results</h3>
          <Link href="/results" className="text-xs font-bold text-forest hover:underline">All results →</Link>
        </div>
        {resultRows.length === 0 ? (
          <Empty icon="file" title="No published results yet" sub="Published examination results will appear here with marksheets." />
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Examination</th><th>Year</th><th>Obtained</th><th>Percentage</th><th>GPA</th><th>Result</th><th className="text-right">Marksheet</th></tr>
            </thead>
            <tbody>
              {resultRows.map((r) => (
                <tr key={r.examId}>
                  <td className="font-bold">{r.examName}</td>
                  <td className="text-muted">{fmtDate(r.endDate)}</td>
                  <td>—</td>
                  <td>{r.pct != null ? `${r.pct}%` : "—"}</td>
                  <td className="font-bold text-forest">{r.gpa}</td>
                  <td>{r.status === "PASS" ? <Badge tone="green">PASS</Badge> : r.status === "FAIL" ? <Badge tone="red">FAIL</Badge> : <Badge tone="amber">PENDING</Badge>}</td>
                  <td className="text-right">
                    <Link href={`/marksheet?exam=${r.examId}&student=${studentId}`} className="inline-flex items-center gap-1 text-xs font-bold text-forest hover:underline">
                      <Icon name="file" className="w-3.5 h-3.5" /> View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card overflow-hidden mt-4">
        <div className="p-4 border-b">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-lg font-semibold">Fee Details</h2>
              <p className="text-sm text-gray-500">Student invoices and payment records</p>
            </div>
            {user.role === "admin" && (
              <Link href="/fees" className="btn-primary btn-sm">
                Manage Fees
              </Link>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Total Billed</p>
              <p className="text-lg font-semibold">{formatFeeAmount(totalBilledPaisa)}</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Total Paid</p>
              <p className="text-lg font-semibold text-green-700">{formatFeeAmount(totalPaidPaisa)}</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Outstanding Balance</p>
              <p className="text-lg font-semibold text-red-600">{formatFeeAmount(totalDuePaisa)}</p>
            </div>
          </div>
        </div>

        <div className="p-4">
          <h3 className="font-semibold mb-3">Invoice History</h3>
          {feeInvoiceRows.length === 0 ? (
            <p className="text-sm text-gray-500">No fee invoices found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl w-full">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Issue Date</th>
                    <th>Due Date</th>
                    <th>Total</th>
                    <th>Paid</th>
                    <th>Due</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {feeInvoiceRows.map((invoice) => {
                    const paid = paidByInvoice.get(invoice.id) ?? 0;
                    const due = Math.max(0, invoice.totalPaisa - paid);
                    return (
                      <tr key={invoice.id}>
                        <td>{invoice.invoiceNo}</td>
                        <td>{fmtDate(invoice.issueDate)}</td>
                        <td>{fmtDate(invoice.dueDate)}</td>
                        <td>{formatFeeAmount(invoice.totalPaisa)}</td>
                        <td>{formatFeeAmount(paid)}</td>
                        <td>{formatFeeAmount(due)}</td>
                        <td>
                          <Link href={"/fees/invoices/" + invoice.id} className="text-blue-600 underline">
                            View / Print
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="p-4 border-t">
          <h3 className="font-semibold mb-3">Payment History</h3>
          {feePaymentRows.length === 0 ? (
            <p className="text-sm text-gray-500">No payments recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl w-full">
                <thead>
                  <tr>
                    <th>Receipt No.</th>
                    <th>Payment Date</th>
                    <th>Method</th>
                    <th>Amount</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {feePaymentRows.map((payment) => (
                    <tr key={payment.id}>
                      <td>{payment.receiptNo}</td>
                      <td>{fmtDate(payment.paidAt)}</td>
                      <td>{payment.paymentMethod}</td>
                      <td>{formatFeeAmount(payment.amountPaisa)}</td>
                      <td>
                        <Link href={"/fees/receipts/" + payment.id} className="text-blue-600 underline">
                          View / Print
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}



