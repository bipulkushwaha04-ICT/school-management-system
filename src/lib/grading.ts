import "server-only";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  gradingScale,
  examSubjects,
  marks,
  enrollments,
  classes,
  sections,
  subjects,
  students,
  attendance,
  settings as settingsTable,
  schools,
} from "@/db/schema";
import { DEFAULT_SCHOOL as DEFAULT_SCHOOL_INFO } from "@/db/defaults";

/* ------------------------------ Grading scale ----------------------------- */

export type ScaleRow = {
  grade: string;
  minPct: number;
  maxPct: number;
  points10: number;
  isFail: boolean;
};

/** Default scale (same as the seed) used until a school configures its own. */
export const DEFAULT_SCALE: ScaleRow[] = [
  { grade: "A+", minPct: 90, maxPct: 100, points10: 40, isFail: false },
  { grade: "A", minPct: 85, maxPct: 89, points10: 36, isFail: false },
  { grade: "B+", minPct: 80, maxPct: 84, points10: 32, isFail: false },
  { grade: "B", minPct: 75, maxPct: 79, points10: 28, isFail: false },
  { grade: "C+", minPct: 70, maxPct: 74, points10: 24, isFail: false },
  { grade: "C", minPct: 65, maxPct: 69, points10: 20, isFail: false },
  { grade: "D+", minPct: 60, maxPct: 64, points10: 16, isFail: false },
  { grade: "D", minPct: 55, maxPct: 59, points10: 12, isFail: false },
  { grade: "E", minPct: 40, maxPct: 54, points10: 8, isFail: false },
  { grade: "F", minPct: 0, maxPct: 39, points10: 0, isFail: true },
];

export async function getScale(schoolId: number): Promise<ScaleRow[]> {
  const rows = await db
    .select()
    .from(gradingScale)
    .where(eq(gradingScale.schoolId, schoolId))
    .orderBy(gradingScale.sortOrder);

  if (rows.length === 0) return DEFAULT_SCALE;

  return rows.map((r) => ({
    grade: r.grade,
    minPct: r.minPct,
    maxPct: r.maxPct,
    points10: r.points10,
    isFail: r.isFail,
  }));
}

export function gradeFor(
  pct: number,
  scale: ScaleRow[],
): { grade: string; points10: number; fail: boolean } {
  const row =
    scale.find((s) => pct >= s.minPct && pct < s.maxPct + 1 && !s.isFail) ??
    scale.find((s) => s.isFail);

  if (!row) return { grade: "F", points10: 0, fail: true };

  return {
    grade: row.grade,
    points10: row.points10,
    fail: row.isFail,
  };
}

/* ------------------------------ Result engine ----------------------------- */

export type SubjectResult = {
  subjectId: number;
  subjectName: string;

  fullMarks: number;
  passMarks: number;

  theoryFull: number;
  theoryPassMarks: number;
  theory: number | null;
  theoryHighest: number | null;
  theoryPct: number | null;
  theoryGrade: string;
  theoryPoints10: number;
  theoryPass: boolean;

  practicalFull: number;
  practicalPassMarks: number;
  practical: number | null;
  practicalHighest: number | null;
  practicalPct: number | null;
  practicalGrade: string;
  practicalPoints10: number;
  practicalPass: boolean;

  total: number | null;
  pct: number | null;
  grade: string;
  points10: number;
  pass: boolean;
};

export type StudentResult = {
  studentId: number;
  studentName: string;
  admissionNo: string;
  rollNo: number | null;
  rows: SubjectResult[];
  totalFull: number;
  totalObtained: number | null;
  pct: number | null;
  gpa: number | null;
  gpaDisplay: string;
  passed: boolean;
  result: "PASS" | "FAIL" | "PENDING";
};

/**
 * Compute results for every active enrollee of a class in an examination.
 * Missing marks are retained as pending subject rows.
 */
export async function computeClassResults(
  examId: number,
  classId: number,
  scale: ScaleRow[] | undefined,
  schoolId: number,
): Promise<StudentResult[]> {
  const gradingScaleRows = scale ?? (await getScale(schoolId));

  const subRows = await db
    .select({
      id: examSubjects.id,
      subjectId: examSubjects.subjectId,
      subjectName: subjects.name,
      fullMarks: examSubjects.fullMarks,
      practicalFull: examSubjects.practicalMarks,
      passMarks: examSubjects.passMarks,
      theory: marks.theory,
      practical: marks.practical,
      studentId: marks.studentId,
    })
    .from(examSubjects)
    .innerJoin(subjects, eq(subjects.id, examSubjects.subjectId))
    .leftJoin(marks, eq(marks.examSubjectId, examSubjects.id))
    .where(
      and(
        eq(examSubjects.examId, examId),
        eq(examSubjects.classId, classId),
        eq(examSubjects.schoolId, schoolId),
      ),
    );

  const enrollees = await db
    .select({
      studentId: enrollments.studentId,
      rollNo: enrollments.rollNo,
      name: students.name,
      admissionNo: students.admissionNo,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        eq(enrollments.classId, classId),
        eq(enrollments.status, "active"),
        eq(enrollments.schoolId, schoolId),
      ),
    )
    .orderBy(enrollments.rollNo);

  type SubjectMeta = {
    id: number;
    subjectId: number;
    subjectName: string;
    fullMarks: number;
    practicalFull: number;
    passMarks: number;
    theoryFull: number;
    theoryPassMarks: number;
    practicalPassMarks: number;
    theoryHighest: number | null;
    practicalHighest: number | null;
  };

  const subjectMeta = new Map<number, SubjectMeta>();

  for (const r of subRows) {
    if (!subjectMeta.has(r.id)) {
      const fullMarks = r.fullMarks;
      const practicalFull = Math.min(
        Math.max(r.practicalFull, 0),
        fullMarks,
      );
      const theoryFull = Math.max(fullMarks - practicalFull, 0);

      const theoryPassMarks =
        fullMarks > 0
          ? Math.ceil((r.passMarks * theoryFull) / fullMarks)
          : 0;

      const practicalPassMarks = Math.max(
        r.passMarks - theoryPassMarks,
        0,
      );

      subjectMeta.set(r.id, {
        id: r.id,
        subjectId: r.subjectId,
        subjectName: r.subjectName,
        fullMarks,
        practicalFull,
        passMarks: r.passMarks,
        theoryFull,
        theoryPassMarks,
        practicalPassMarks,
        theoryHighest: null,
        practicalHighest: null,
      });
    }

    const meta = subjectMeta.get(r.id)!;

    if (r.studentId != null) {
      if (r.theory != null) {
        meta.theoryHighest =
          meta.theoryHighest == null
            ? r.theory
            : Math.max(meta.theoryHighest, r.theory);
      }

      if (meta.practicalFull > 0 && r.practical != null) {
        meta.practicalHighest =
          meta.practicalHighest == null
            ? r.practical
            : Math.max(meta.practicalHighest, r.practical);
      }
    }
  }

  const marksByStudent = new Map<
    number,
    Map<number, (typeof subRows)[number]>
  >();

  for (const r of subRows) {
    if (r.studentId == null) continue;

    if (!marksByStudent.has(r.studentId)) {
      marksByStudent.set(r.studentId, new Map());
    }

    marksByStudent.get(r.studentId)!.set(r.id, r);
  }

  const subjectsList = Array.from(subjectMeta.values());

  const out: StudentResult[] = enrollees.map((enrollee) => {
    const studentMarks = marksByStudent.get(enrollee.studentId);

    const rows: SubjectResult[] = subjectsList.map((meta) => {
      const markRow = studentMarks?.get(meta.id);

      const theory =
        markRow == null ? null : markRow.theory;

      const practical =
        markRow == null || meta.practicalFull === 0
          ? null
          : markRow.practical;

      const total =
        markRow == null
          ? null
          : (markRow.theory ?? 0) +
            (meta.practicalFull > 0 ? (markRow.practical ?? 0) : 0);

      const theoryPct =
        theory == null || meta.theoryFull <= 0
          ? null
          : Math.round((theory / meta.theoryFull) * 1000) / 10;

      const practicalPct =
        practical == null || meta.practicalFull <= 0
          ? null
          : Math.round((practical / meta.practicalFull) * 1000) / 10;

      const pct =
        total == null || meta.fullMarks <= 0
          ? null
          : Math.round((total / meta.fullMarks) * 1000) / 10;

      const theoryGrade = theoryPct == null ? { grade: "—", points10: 0, fail: false } : gradeFor(theoryPct, gradingScaleRows);

      const practicalGrade = practicalPct == null ? { grade: "—", points10: 0, fail: false } : gradeFor(practicalPct, gradingScaleRows);

      const subjectGrade =
        pct == null
          ? { grade: "—", points10: 0, fail: false }
          : gradeFor(pct, gradingScaleRows);

      const theoryPass =
        meta.theoryFull === 0 ||
        (theory != null && theory >= meta.theoryPassMarks);

      const practicalPass =
        meta.practicalFull === 0 ||
        (practical != null && practical >= meta.practicalPassMarks);

      const pass =
        total != null &&
        total >= meta.passMarks &&
        theoryPass &&
        practicalPass;

      return {
        subjectId: meta.subjectId,
        subjectName: meta.subjectName,

        fullMarks: meta.fullMarks,
        passMarks: meta.passMarks,

        theoryFull: meta.theoryFull,
        theoryPassMarks: meta.theoryPassMarks,
        theory,
        theoryHighest: meta.theoryHighest,
        theoryPct,
        theoryGrade: theoryGrade.grade,
        theoryPoints10: theoryGrade.points10,
        theoryPass,

        practicalFull: meta.practicalFull,
        practicalPassMarks: meta.practicalPassMarks,
        practical,
        practicalHighest: meta.practicalHighest,
        practicalPct,
        practicalGrade: practicalGrade.grade,
        practicalPoints10: practicalGrade.points10,
        practicalPass,

        total,
        pct,
        grade: subjectGrade.grade,
        points10: subjectGrade.points10,
        pass,
      };
    });

    const totalFull = rows.reduce(
      (sum, row) => sum + row.fullMarks,
      0,
    );

    const allMarksEntered =
      rows.length > 0 && rows.every((row) => row.total != null);

    const totalObtained = allMarksEntered
      ? rows.reduce((sum, row) => sum + (row.total ?? 0), 0)
      : null;

    const pct =
      totalObtained == null || totalFull <= 0
        ? null
        : Math.round((totalObtained / totalFull) * 1000) / 10;

    const gpa =
      allMarksEntered
        ? Math.round(
            (rows.reduce((sum, row) => sum + row.points10, 0) /
              rows.length /
              10) *
              10,
          ) / 10
        : null;

    const passed =
      allMarksEntered && rows.length > 0 && rows.every((row) => row.pass);

    return {
      studentId: enrollee.studentId,
      studentName: enrollee.name,
      admissionNo: enrollee.admissionNo,
      rollNo: enrollee.rollNo,
      rows,
      totalFull,
      totalObtained,
      pct,
      gpa,
      gpaDisplay: gpa == null ? "—" : gpa.toFixed(1),
      passed,
      result:
        !allMarksEntered
          ? "PENDING"
          : passed
            ? "PASS"
            : "FAIL",
    };
  });

  out.sort((a, b) => (a.rollNo ?? 0) - (b.rollNo ?? 0));

  return out;
}

/* ------------------------------ Attendance % ------------------------------ */

export async function attendancePct(
  studentId: number,
  from: Date | undefined,
  to: Date | undefined,
  schoolId: number,
) {
  const conds = [
    eq(attendance.studentId, studentId),
    eq(attendance.schoolId, schoolId),
  ];

  if (from) {
    conds.push(
      sql`${attendance.attDate} >= ${dateStr(from)}`,
    );
  }

  if (to) {
    conds.push(
      sql`${attendance.attDate} <= ${dateStr(to)}`,
    );
  }

  const rows = await db
    .select({
      status: attendance.status,
      c: sql<number>`count(*)::int`,
    })
    .from(attendance)
    .where(and(...conds))
    .groupBy(attendance.status);

  const map: Record<string, number> = {};
  let total = 0;

  for (const r of rows) {
    map[r.status] = r.c;
    total += r.c;
  }

  const present = (map["P"] ?? 0) + (map["L"] ?? 0);
  const pct =
    total === 0
      ? 100
      : Math.round((present / total) * 1000) / 10;

  return {
    pct,
    present,
    absent: map["A"] ?? 0,
    late: map["L"] ?? 0,
    leave: map["LV"] ?? 0,
    total,
  };
}

/* ------------------------------ Small helpers ----------------------------- */

export function fmtDate(
  d: string | Date | null | undefined,
): string {
  if (!d) return "—";

  const date =
    typeof d === "string"
      ? new Date(d + (d.length === 10 ? "T00:00:00" : ""))
      : d;

  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function dateStr(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayStr(): string {
  return dateStr(new Date());
}

export function addDays(d: Date, n: number): string {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return dateStr(c);
}

/**
 * `settings` is a global key/value table. School 1 keeps the original bare
 * keys for backward compatibility; every other tenant uses `s<id>:<key>`.
 */
export function settingKey(schoolId: number, key: string): string {
  return schoolId === 1 ? key : `s${schoolId}:${key}`;
}

export async function getSetting(
  key: string,
  schoolId: number,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.key, settingKey(schoolId, key)))
    .limit(1);

  return rows[0]?.value ?? null;
}

export const DEFAULT_SCHOOL = DEFAULT_SCHOOL_INFO;

export type SchoolInfo = {
  name: string;
  nameNp: string;
  address: string;
  contact: string;
  email: string;
  website: string;
  logoUrl: string | null;
  principalName: string;
  minAttendance: number;
};

/** Branding and policy for one tenant: the schools row first, then its scoped settings. */
export async function getSchool(schoolId: number): Promise<SchoolInfo> {
  const keys = [
    "school_name", "school_name_np", "school_address", "school_contact",
    "school_email", "school_website", "school_logo", "principal_name", "min_attendance",
  ];
  const [schoolRows, settingRows] = await Promise.all([
    db.select().from(schools).where(eq(schools.id, schoolId)).limit(1),
    db
      .select()
      .from(settingsTable)
      .where(inArray(settingsTable.key, keys.map((k) => settingKey(schoolId, k)))),
  ]);
  const row = schoolRows[0];
  const map: Record<string, string> = {};
  for (const r of settingRows) {
    const bare = schoolId === 1 ? r.key : r.key.slice(`s${schoolId}:`.length);
    map[bare] = r.value ?? "";
  }
  // Only the original school falls back to its historical defaults.
  const fallback = schoolId === 1
    ? DEFAULT_SCHOOL
    : { name: "", nameNp: "", address: "", contact: "", email: "", website: "" };

  const minAttendance = Number(map["min_attendance"]);

  return {
    name: map["school_name"] || row?.name || fallback.name || "School",
    nameNp: map["school_name_np"] || row?.nameNp || fallback.nameNp,
    address: map["school_address"] || row?.address || fallback.address,
    contact: map["school_contact"] || row?.phone || fallback.contact,
    email: map["school_email"] || row?.contactEmail || fallback.email,
    website: map["school_website"] || fallback.website,
    logoUrl: map["school_logo"] || row?.logoUrl || null,
    principalName: map["principal_name"] || row?.principalName || "Head Teacher",
    minAttendance:
      Number.isFinite(minAttendance) && minAttendance >= 0 && minAttendance <= 100
        ? minAttendance
        : 75,
  };
}

/** Class/section label helper */
export async function classLabel(
  classId: number | null,
  sectionId: number | null,
  schoolId: number,
) {
  if (!classId) return "—";

  const [c, s] = await Promise.all([
    db
      .select()
      .from(classes)
      .where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)))
      .limit(1),
    sectionId
      ? db
          .select()
          .from(sections)
          .where(and(eq(sections.id, sectionId), eq(sections.schoolId, schoolId)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const cls = c[0]?.name ?? "—";

  return s[0] ? `${cls} – ${s[0].name}` : cls;
}

