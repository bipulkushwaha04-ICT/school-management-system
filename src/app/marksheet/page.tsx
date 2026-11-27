import Image from "next/image";
import PrintButton from "@/components/print-button";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq, and, sql, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  examinations,
  examSubjects,
  classes,
  sections,
  students,
  enrollments,
  academicYears,
  parentChildren,
  classSubjects,
  teachers,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { currentSchoolId } from "@/lib/tenant";
import {
  attendancePct,
  computeClassResults,
  fmtDate,
  getScale,
  getSchool,
} from "@/lib/grading";
import { Icon } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MarksheetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const schoolId = await currentSchoolId();
  const sp = await searchParams;
  const examId = Number(sp.exam ?? 0);
  const studentId = Number(sp.student ?? 0);

  if (!examId || !studentId) notFound();

  if (user.role === "student" && user.studentId !== studentId) {
    redirect("/results");
  }

  if (user.role === "parent") {
    const link = await db
      .select()
      .from(parentChildren)
      .where(
        and(
          eq(parentChildren.userId, user.id),
          eq(parentChildren.studentId, studentId),
          eq(parentChildren.schoolId, schoolId),
        ),
      )
      .limit(1);

    if (link.length === 0) redirect("/results");
  }

  const [exam] = await db
    .select({
      exam: examinations,
      year: sql<string>`academic_years.name`,
    })
    .from(examinations)
    .innerJoin(
      academicYears,
      eq(academicYears.id, examinations.academicYearId),
    )
    .where(and(eq(examinations.id, examId), eq(examinations.schoolId, schoolId)))
    .limit(1);

  if (!exam) notFound();

  if ((user.role === "student" || user.role === "parent") && exam.exam.status !== "published") {
    redirect("/results");
  }

  const [student] = await db
    .select()
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .limit(1);

  if (!student) notFound();

  const examSubjectsOf = await db
    .select({
      id: examSubjects.id,
      classId: examSubjects.classId,
      subjectId: examSubjects.subjectId,
    })
    .from(examSubjects)
    .where(and(eq(examSubjects.examId, examId), eq(examSubjects.schoolId, schoolId)));

  const classIds = new Set(examSubjectsOf.map((e) => e.classId));

  const [enr] = await db
    .select({
      className: classes.name,
      classId: enrollments.classId,
      section: sections.name,
      rollNo: enrollments.rollNo,
    })
    .from(enrollments)
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .where(
      and(
        eq(enrollments.studentId, studentId),
        classIds.size > 0
          ? or(
              inArray(enrollments.classId, Array.from(classIds)),
              isNull(enrollments.classId),
            )
          : undefined,
        eq(enrollments.academicYearId, exam.exam.academicYearId),
        eq(enrollments.schoolId, schoolId),
      ),
    )
    .limit(1);
  const classId = enr?.classId ?? null;

  const [scale, school, att] = await Promise.all([
    getScale(schoolId),
    getSchool(schoolId),
    attendancePct(
      studentId,
      exam.exam.startDate ? new Date(`${exam.exam.startDate}T00:00:00`) : undefined,
      new Date(),
      schoolId,
    ),
  ]);

  const resultRow = classId
    ? (await computeClassResults(examId, classId, scale, schoolId)).find(
        (r) => r.studentId === studentId,
      )
    : undefined;

  const [ct] = await db
    .select({ name: teachers.name })
    .from(classSubjects)
    .leftJoin(
      teachers,
      eq(teachers.id, classSubjects.teacherId),
    )
    .where(
      and(
        classId ? eq(classSubjects.classId, classId) : isNull(classSubjects.classId),
        eq(classSubjects.isClassTeacher, true),
        eq(classSubjects.schoolId, schoolId),
      ),
    )
    .limit(1);

  const principalName = school.principalName;
  const logoUrl = school.logoUrl || "/images/emblem.png";

  const rows = resultRow?.rows ?? [];

  const theoryFullTotal = rows.reduce(
    (sum, row) => sum + row.theoryFull,
    0,
  );
  const theoryObtainedTotal = rows.every(
    (row) => row.theory != null,
  )
    ? rows.reduce((sum, row) => sum + (row.theory ?? 0), 0)
    : null;

  const practicalFullTotal = rows.reduce(
    (sum, row) => sum + row.practicalFull,
    0,
  );
  const practicalObtainedTotal = rows.every(
    (row) => row.practicalFull === 0 || row.practical != null,
  )
    ? rows.reduce((sum, row) => sum + (row.practical ?? 0), 0)
    : null;

  const theoryPassTotal = rows.reduce(
    (sum, row) => sum + row.theoryPassMarks,
    0,
  );
  const practicalPassTotal = rows.reduce(
    (sum, row) => sum + row.practicalPassMarks,
    0,
  );

  const statusClass = (passed: boolean, pending: boolean) => {
    if (pending) return "status-pending";
    return passed ? "status-pass" : "status-fail";
  };

  const statusText = (passed: boolean, pending: boolean) => {
    if (pending) return "PENDING";
    return passed ? "PASS" : "FAIL";
  };

  const generatedDate = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <main className="marksheet-page min-h-screen bg-paper px-3 py-6 sm:px-5">
      <style>{`
        .marksheet-page {
          color: #17251f;
        }
        .marksheet-sheet {
          width: 100%;
          max-width: 1100px;
          margin: 0 auto;
          background: #fff;
          border: 1px solid #d7dfda;
          box-shadow: 0 8px 30px rgba(20, 50, 35, .08);
        }
        .marksheet-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
        }
        .marksheet-table th,
        .marksheet-table td {
          border: 1px solid #cbd5cf;
          padding: 6px 5px;
          text-align: center;
          vertical-align: middle;
        }
        .marksheet-table th {
          font-weight: 700;
        }
        .marksheet-table .subject-cell {
          text-align: left;
          min-width: 115px;
          font-weight: 600;
        }
        .marksheet-table .group-theory {
          background: #e9f1ed;
          color: #174d38;
        }
        .marksheet-table .group-practical {
          background: #fff3df;
          color: #805016;
        }
        .marksheet-table .group-total {
          background: #e9edf8;
          color: #263c72;
        }
        .status-pass {
          color: #17643d;
          font-weight: 800;
        }
        .status-fail {
          color: #b42318;
          font-weight: 800;
        }
        .status-pending {
          color: #95600a;
          font-weight: 800;
        }
        .marksheet-summary {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
        }
        .marksheet-summary-card {
          border: 1px solid #d7dfda;
          border-radius: 8px;
          padding: 12px;
          text-align: center;
        }
        @media (max-width: 700px) {
          .marksheet-summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @page {
          size: A4 portrait;
          margin: 5mm;
        }

        @media print {
          html, body {
            width: auto !important;
            height: auto !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: visible !important;
            background: #fff !important;
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
          }

          .no-print {
            display: none !important;
          }

          .marksheet-page {
            width: 100% !important;
            height: auto !important;
            min-height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: visible !important;
          }

          .marksheet-sheet {
            width: 100% !important;
            max-width: none !important;
            min-height: 287mm !important;
            margin: 0 !important;
            padding: 4mm !important;
            box-sizing: border-box !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: space-between !important;
            border: 1px solid #aebbb3 !important;
            box-shadow: none !important;
            zoom: 0.92;
          }

          .marksheet-sheet header {
            padding: 7px 10px !important;
          }

          .marksheet-sheet header img {
            width: 48px !important;
            height: 48px !important;
          }

          .marksheet-sheet section {
            margin-top: 6px !important;
            margin-bottom: 6px !important;
            padding-top: 6px !important;
            padding-bottom: 6px !important;
          }

          .marksheet-sheet h3,
          .marksheet-sheet h4 {
            margin-bottom: 4px !important;
            font-size: 11px !important;
          }

          .marksheet-table {
            width: 100% !important;
            table-layout: fixed !important;
            font-size: 7.5px !important;
          }

          .marksheet-table th,
          .marksheet-table td {
            padding: 3px 2px !important;
            line-height: 1.2 !important;
          }

          .marksheet-table .subject-cell {
            min-width: 0 !important;
          }

          .marksheet-summary {
            gap: 5px !important;
          }

          .marksheet-summary-card {
            padding: 5px !important;
          }

          .marksheet-summary-card p.text-xl {
            margin-top: 3px !important;
            font-size: 14px !important;
          }

          .marksheet-signatures {
            margin-top: 15px !important;
            break-inside: avoid !important;
          }

          .marksheet-signatures > div {
            break-inside: avoid !important;
          }

          .marksheet-sheet .mt-7 {
            margin-top: 8px !important;
          }

          .marksheet-sheet .mt-12 {
            margin-top: 14px !important;
          }

          .marksheet-table tr {
            break-inside: avoid !important;
          }

          .marksheet-sheet * {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>

      <div className="no-print mx-auto mb-4 flex max-w-[1100px] items-center justify-between gap-3">
        <Link
          href="/results"
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-4 py-2 text-sm font-semibold text-inksoft hover:text-forest"
        >
          <Icon name="back" className="h-4 w-4" />
          Back to results
        </Link>
        <PrintButton />
      </div>

      <article className="marksheet-sheet">
        {/* School heading */}
        <header className="border-b-4 border-forest bg-white px-5 py-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Image
              src={logoUrl}
              alt="School logo"
              width={78}
              height={78}
              unoptimized
              className="h-[70px] w-[70px] shrink-0 rounded-full border border-line bg-white object-contain p-1"
            />

            <div className="min-w-0 flex-1 text-center">
              <p className="font-deva text-sm font-bold text-forest sm:text-base">
                {school.nameNp}
              </p>
              <h1 className="mt-1 text-xl font-extrabold tracking-tight text-forest-deep sm:text-2xl">
                {school.name}
              </h1>
              <p className="mt-1 text-xs text-muted">
                {school.address}
              </p>
              <p className="text-xs text-muted">
                {school.contact}
                {school.email ? ` | ${school.email}` : ""}
                {school.website ? ` | ${school.website}` : ""}
              </p>
            </div>

            <div className="w-[70px] shrink-0 text-center">
              <div className="rounded-md border border-forest/30 px-2 py-2 text-[10px] font-bold leading-tight text-forest">
                OFFICIAL
                <br />
                RECORD
              </div>
            </div>
          </div>
        </header>

        <div className="px-4 py-5 sm:px-7">
          {/* Report title */}
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-3">
            <div>
              <h2 className="text-lg font-extrabold tracking-wide text-ink">
                STUDENT ACADEMIC REPORT
              </h2>
              <p className="font-deva text-sm font-semibold text-forest">
                विद्यार्थीको शैक्षिक उपलब्धि विवरण
              </p>
              <p className="mt-1 text-xs text-muted">
                {exam.exam.name}
              </p>
            </div>

            <div className="text-right text-xs leading-6">
              <p>
                <span className="text-muted">Academic Year / शैक्षिक सत्र: </span>
                <strong>{exam.year}</strong>
              </p>
              <p>
                <span className="text-muted">Exam Date / परीक्षा मिति: </span>
                <strong>
                  {fmtDate(exam.exam.startDate)} – {fmtDate(exam.exam.endDate)}
                </strong>
              </p>
            </div>
          </div>

          {/* Student details */}
          <section className="mb-5 rounded-lg border border-line bg-[#f8faf9] p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
              <h3 className="font-deva text-sm font-bold text-forest">
                विद्यार्थी विवरण
              </h3>
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                Student Information
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs sm:grid-cols-4">
              <div>
                <p className="text-muted">Student Name / विद्यार्थीको नाम</p>
                <p className="mt-0.5 font-bold text-ink">{student.name}</p>
              </div>
              <div>
                <p className="text-muted">Admission No. / भर्ना नं.</p>
                <p className="mt-0.5 font-bold">{student.admissionNo}</p>
              </div>
              <div>
                <p className="text-muted">Class & Section / कक्षा र समूह</p>
                <p className="mt-0.5 font-bold">
                  {enr?.className ?? "—"} – {enr?.section ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-muted">Roll No. / रोल नं.</p>
                <p className="mt-0.5 font-bold">{enr?.rollNo ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted">Father&apos;s Name / बुबाको नाम</p>
                <p className="mt-0.5 font-semibold">{student.fatherName ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted">Mother&apos;s Name / आमाको नाम</p>
                <p className="mt-0.5 font-semibold">{student.motherName ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted">Date of Birth / जन्म मिति</p>
                <p className="mt-0.5 font-semibold">{fmtDate(student.dob)}</p>
              </div>
              <div>
                <p className="text-muted">Attendance / उपस्थिति</p>
                <p className="mt-0.5 font-semibold">{att.pct}%</p>
              </div>
            </div>
          </section>

          {/* Marks table */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-deva text-sm font-bold text-forest">
                विषयगत प्राप्ताङ्क विवरण
              </h3>
              <p className="text-[10px] text-muted">
                Subject-wise Marks and Grade Details
              </p>
            </div>

            <div className="w-full overflow-x-auto">
              <table className="marksheet-table">
                <thead>
                  <tr>
                    <th rowSpan={2} className="bg-[#f1f4f2]">S.N.</th>
                    <th rowSpan={2} className="bg-[#f1f4f2]">Subject / विषय</th>
                    <th colSpan={7} className="group-theory">THEORY / सैद्धान्तिक</th>
                    <th colSpan={7} className="group-practical">PRACTICAL / प्रयोगात्मक</th>
                    <th colSpan={6} className="group-total">SUBJECT RESULT / नतिजा</th>
                  </tr>
                  <tr>
                    <th className="group-theory">Full</th>
                    <th className="group-theory">Pass</th>
                    <th className="group-theory">Obt.</th>
                    <th className="group-theory">Highest</th>
                    <th className="group-theory">GPA</th>
                    <th className="group-theory">Grade</th>
                    <th className="group-theory">Result</th>

                    <th className="group-practical">Full</th>
                    <th className="group-practical">Pass</th>
                    <th className="group-practical">Obt.</th>
                    <th className="group-practical">Highest</th>
                    <th className="group-practical">GPA</th>
                    <th className="group-practical">Grade</th>
                    <th className="group-practical">Result</th>

                    <th className="group-total">Full</th>
                    <th className="group-total">Pass</th>
                    <th className="group-total">Obt.</th>
                    <th className="group-total">%</th>
                    <th className="group-total">Grade</th>
                    <th className="group-total">GPA</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((r, index) => {
                    const theoryPending = r.theory == null;
                    const practicalPending =
                      r.practicalFull > 0 && r.practical == null;
                    const subjectPending = r.total == null;

                    return (
                      <tr
                        key={r.subjectId}
                        className={index % 2 === 1 ? "bg-[#fafcfb]" : "bg-white"}
                      >
                        <td>{index + 1}</td>
                        <td className="subject-cell">{r.subjectName}</td>

                        <td>{r.theoryFull}</td>
                        <td>{r.theoryPassMarks}</td>
                        <td className="font-bold">{r.theory ?? "—"}</td>
                        <td>{r.theoryHighest ?? "—"}</td>
                        <td>
                          {theoryPending
                            ? "—"
                            : (r.theoryPoints10 / 10).toFixed(1)}
                        </td>
                        <td className="font-bold">{r.theoryGrade}</td>
                        <td className={statusClass(r.theoryPass, theoryPending)}>
                          {statusText(r.theoryPass, theoryPending)}
                        </td>

                        <td>{r.practicalFull > 0 ? r.practicalFull : "—"}</td>
                        <td>{r.practicalFull > 0 ? r.practicalPassMarks : "—"}</td>
                        <td className="font-bold">
                          {r.practicalFull > 0 ? (r.practical ?? "—") : "—"}
                        </td>
                        <td>
                          {r.practicalFull > 0
                            ? (r.practicalHighest ?? "—")
                            : "—"}
                        </td>
                        <td>
                          {r.practicalFull > 0 && !practicalPending
                            ? (r.practicalPoints10 / 10).toFixed(1)
                            : "—"}
                        </td>
                        <td className="font-bold">
                          {r.practicalFull > 0 ? r.practicalGrade : "—"}
                        </td>
                        <td
                          className={
                            r.practicalFull === 0
                              ? ""
                              : statusClass(r.practicalPass, practicalPending)
                          }
                        >
                          {r.practicalFull > 0
                            ? statusText(r.practicalPass, practicalPending)
                            : "—"}
                        </td>

                        <td>{r.fullMarks}</td>
                        <td>{r.passMarks}</td>
                        <td className="font-extrabold">{r.total ?? "—"}</td>
                        <td>{r.pct == null ? "—" : `${r.pct}%`}</td>
                        <td className="font-extrabold">{r.grade}</td>
                        <td>
                          {subjectPending
                            ? "—"
                            : (r.points10 / 10).toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}

                  {rows.length > 0 && (
                    <tr className="bg-[#edf3ef] font-extrabold">
                      <td colSpan={2} className="text-left">
                        TOTAL
                      </td>

                      <td>{theoryFullTotal}</td>
                      <td>{theoryPassTotal}</td>
                      <td>{theoryObtainedTotal ?? "—"}</td>
                      <td>—</td>
                      <td colSpan={3}>—</td>

                      <td>{practicalFullTotal || "—"}</td>
                      <td>{practicalFullTotal > 0 ? practicalPassTotal : "—"}</td>
                      <td>{practicalObtainedTotal ?? "—"}</td>
                      <td>—</td>
                      <td colSpan={3}>—</td>

                      <td>{resultRow?.totalFull ?? "—"}</td>
                      <td>{rows.reduce((sum, row) => sum + row.passMarks, 0)}</td>
                      <td>{resultRow?.totalObtained ?? "—"}</td>
                      <td>
                        {resultRow?.pct == null ? "—" : `${resultRow.pct}%`}
                      </td>
                      <td>—</td>
                      <td>{resultRow?.gpaDisplay ?? "—"}</td>
                    </tr>
                  )}

                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={22} className="py-8 text-center text-muted">
                        No subjects or marks have been configured for this examination.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-muted">
              Obt. = Obtained Marks. Highest = Highest marks obtained by any
              student in this class and examination. GPA and grades are based
              on the school&apos;s configured grading scale.
            </p>
          </section>

          {/* Overall summary */}
          <section className="mt-5">
            <h3 className="mb-2 font-deva text-sm font-bold text-forest">
              समग्र नतिजा
              <span className="ml-2 font-sans text-[10px] font-normal text-muted">
                Overall Performance Summary
              </span>
            </h3>

            <div className="marksheet-summary">
              <div className="marksheet-summary-card">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
                  Total Marks
                </p>
                <p className="mt-1 text-xl font-extrabold text-ink">
                  {resultRow?.totalObtained ?? "—"}
                  <span className="text-sm font-semibold text-muted">
                    {" "}/ {resultRow?.totalFull ?? "—"}
                  </span>
                </p>
              </div>

              <div className="marksheet-summary-card">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
                  Percentage
                </p>
                <p className="mt-1 text-xl font-extrabold text-ink">
                  {resultRow?.pct == null ? "—" : `${resultRow.pct}%`}
                </p>
              </div>

              <div className="marksheet-summary-card">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
                  Overall GPA
                </p>
                <p className="mt-1 text-xl font-extrabold text-forest">
                  {resultRow?.gpaDisplay ?? "—"}
                  <span className="text-xs font-medium text-muted"> / 4.0</span>
                </p>
              </div>

              <div className="marksheet-summary-card">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted">
                  Final Result
                </p>
                <p
                  className={`mt-1 text-xl font-extrabold ${
                    resultRow?.result === "FAIL"
                      ? "text-danger"
                      : resultRow?.result === "PASS"
                        ? "text-forest"
                        : "text-amber-700"
                  }`}
                >
                  {resultRow?.result ?? "PENDING"}
                </p>
              </div>
            </div>
          </section>

          {/* Grading scale */}
          <section className="mt-4 rounded-lg border border-line bg-[#fafcfb] p-3">
            <h4 className="mb-2 text-xs font-bold text-ink">
              Grading Scale / मूल्याङ्कन श्रेणी
            </h4>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
              {scale.map((item) => (
                <span key={item.grade}>
                  <strong className="text-ink">{item.grade}</strong>
                  {" : "}
                  {item.minPct}–{item.maxPct}%
                  {" ("}
                  {(item.points10 / 10).toFixed(1)}
                  {")"}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-muted">
              Minimum attendance required for promotion: {school.minAttendance}%.
              Theory and practical pass marks are proportionally calculated from
              the configured subject pass marks.
            </p>
          </section>

          {/* Signatures */}
          <section className="marksheet-signatures mt-12 grid grid-cols-3 gap-5 text-center">
            <div>
              <div className="mx-auto mb-2 w-36 border-t border-ink/50" />
              <p className="text-xs font-bold">
                {ct?.name ?? "Class Teacher"}
              </p>
              <p className="font-deva text-[10px] text-muted">
                कक्षा शिक्षक
              </p>
            </div>

            <div>
              <div className="mx-auto mb-2 w-36 border-t border-ink/50" />
              <p className="text-xs font-bold">Exam Controller</p>
              <p className="font-deva text-[10px] text-muted">
                परीक्षा संयोजक
              </p>
            </div>

            <div>
              <div className="mx-auto mb-2 w-36 border-t border-ink/50" />
              <p className="text-xs font-bold">{principalName}</p>
              <p className="font-deva text-[10px] text-muted">
                प्रधानाध्यापक
              </p>
            </div>
          </section>

          <div className="mt-7 flex items-center justify-between border-t border-line pt-3 text-[10px] text-muted">
            <span>{school.name} | {school.website}</span>
            <span>Generated: {generatedDate}</span>
          </div>
        </div>
      </article>
    </main>
  );
}





