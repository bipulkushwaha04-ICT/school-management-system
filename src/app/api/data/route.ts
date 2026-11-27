
import { NextResponse } from "next/server";
import { eq, and, inArray, ne, sql, getTableColumns } from "drizzle-orm";
import { db } from "@/db";
import {
  users,
  parentChildren,
  students,
  teachers,
  classes,
  sections,
  subjects,
  academicYears,
  classSubjects,
  enrollments,
  attendance,
  examinations,
  examSubjects,
  marks,
  notes,
  notices,
  gradingScale,
  settings,
  auditLogs,
  sessions,
  feeCategories,
  feeStructures,
  feeInvoices,
  feeInvoiceItems,
  feePayments,
} from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { PLATFORM_OWNER_USER_ID } from "@/lib/platform-auth";
import { currentSchoolId } from "@/lib/tenant";
import { computeClassResults, getScale } from "@/lib/grading";
import { csvCell, toCsv as toCsvLines } from "@/lib/csv";

export const dynamic = "force-dynamic";

/** Settings keys belonging to one school (see settingKey in lib/grading). */
function isTenantSettingKey(key: string, schoolId: number): boolean {
  if (schoolId === 1) return !/^s\d+:/.test(key);
  return key.startsWith(`s${schoolId}:`);
}

/**
 * Maps a JSON backup row back onto a table's columns: unknown keys are
 * dropped, timestamps become Dates, and school_id is forced to this tenant.
 */
function prepareRow(table: any, raw: unknown, schoolId: number, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid row in ${name}.`);
  }
  const src = raw as Record<string, unknown>;
  const cols = getTableColumns(table) as Record<string, any>;
  const row: Record<string, unknown> = {};
  for (const [prop, col] of Object.entries(cols)) {
    if (!(prop in src)) continue;
    let value = src[prop];
    if (value != null && col.columnType === "PgTimestamp" && typeof value === "string") {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new Error(`Invalid date in ${name}.${prop}.`);
      value = d;
    }
    row[prop] = value;
  }
  if ("schoolId" in cols) {
    if (src.schoolId != null && Number(src.schoolId) !== schoolId) {
      throw new Error(`The ${name} data belongs to a different school.`);
    }
    row.schoolId = schoolId;
  }
  return row;
}

const csvEscape = csvCell;

function toCsv(headers: string[], rows: unknown[][]): string {
  return toCsvLines(headers, rows, "\n");
}

async function csvResponse(content: string, filename: string) {
  return new NextResponse(content, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(req: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Admin only" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const schoolId = await currentSchoolId();

  const url = new URL(req.url);
  const op = url.searchParams.get("op");
  const type = url.searchParams.get("type") ?? "students";

  if (op === "backup") {
    const tables = [
      ["academic_years", academicYears],
      ["classes", classes],
      ["sections", sections],
      ["subjects", subjects],
      ["students", students],
      ["teachers", teachers],
      ["users", users],
      ["parent_children", parentChildren],
      ["class_subjects", classSubjects],
      ["enrollments", enrollments],
      ["attendance", attendance],
      ["examinations", examinations],
      ["exam_subjects", examSubjects],
      ["marks", marks],
      ["notes", notes],
      ["notices", notices],
      ["grading_scale", gradingScale],
      ["settings", settings],
      ["audit_logs", auditLogs],
      ["fee_categories", feeCategories],
      ["fee_structures", feeStructures],
      ["fee_invoices", feeInvoices],
      ["fee_invoice_items", feeInvoiceItems],
      ["fee_payments", feePayments],
    ] as const;

    const out: Record<string, unknown[]> = {};

    for (const [name, table] of tables) {
      out[name] = name === "settings"
        ? (await db.select().from(settings)).filter((r) => isTenantSettingKey(r.key, schoolId))
        : await db.select().from(table as any).where(eq((table as any).schoolId, schoolId));
    }

    return new Response(
      JSON.stringify(
        {
          app: "sjjs-sms",
          schoolId,
          exportedAt: new Date().toISOString(),
          data: out,
        },
        null,
        1
      ),
      {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="sjjs-backup-${new Date().toISOString().slice(0, 10)}.json"`,
          "Cache-Control": "private, no-store",
        },
      }
    );
  }

  if (op !== "export") {
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  }

  if (type === "students") {
    const rows = await db
      .select({
        name: students.name,
        adm: students.admissionNo,
        dob: students.dob,
        gender: students.gender,
        cls: classes.name,
        sec: sections.name,
        roll: enrollments.rollNo,
        father: students.fatherName,
        contact: students.contact,
        address: students.address,
      })
      .from(students)
      .leftJoin(
        enrollments,
        and(
          eq(enrollments.studentId, students.id),
          eq(enrollments.status, "active"),
          eq(enrollments.schoolId, schoolId)
        )
      )
      .leftJoin(classes, and(eq(classes.id, enrollments.classId), eq(classes.schoolId, schoolId)))
      .leftJoin(sections, and(eq(sections.id, enrollments.sectionId), eq(sections.schoolId, schoolId)))
      .where(and(sql`${students.deletedAt} is null`, eq(students.schoolId, schoolId)))
      .orderBy(students.name);

    return csvResponse(
      toCsv(
        [
          "Name",
          "Admission No",
          "DOB",
          "Gender",
          "Class",
          "Section",
          "Roll",
          "Father",
          "Contact",
          "Address",
        ],
        rows.map((r) => [
          r.name,
          r.adm,
          r.dob,
          r.gender,
          r.cls,
          r.sec,
          r.roll,
          r.father,
          r.contact,
          r.address,
        ])
      ),
      "students.csv"
    );
  }

  if (type === "teachers") {
    const rows = await db.select().from(teachers)
      .where(eq(teachers.schoolId, schoolId))
      .orderBy(teachers.name);

    return csvResponse(
      toCsv(
        [
          "Name",
          "Employee No",
          "Gender",
          "Phone",
          "Email",
          "Qualification",
          "Joined",
          "Status",
        ],
        rows.map((r) => [
          r.name,
          r.employeeNo,
          r.gender,
          r.phone,
          r.email,
          r.qualification,
          r.joinDate,
          r.status,
        ])
      ),
      "teachers.csv"
    );
  }

  if (type === "classes") {
    const rows = await db
      .select({
        name: classes.name,
        level: classes.level,
        sections: sql<number>`(
          select count(*)
          from sections
          where sections.class_id = ${classes.id}
          and sections.school_id = ${schoolId}
        )::int`,
        students: sql<number>`(
          select count(*)
          from enrollments
          where enrollments.class_id = ${classes.id}
          and enrollments.school_id = ${schoolId}
          and enrollments.status = 'active'
        )::int`,
      })
      .from(classes)
      .where(eq(classes.schoolId, schoolId))
      .orderBy(classes.sortOrder);

    return csvResponse(
      toCsv(
        ["Class", "Level", "Sections", "Active Students"],
        rows.map((r) => [
          r.name,
          r.level,
          r.sections,
          r.students,
        ])
      ),
      "classes.csv"
    );
  }

  if (type === "attendance") {
    const classId = url.searchParams.get("classId");
    const sectionId = url.searchParams.get("sectionId");
    const studentId = url.searchParams.get("student");

    let where: any = sql`true`;

    if (studentId) {
      const parsedStudentId = Number(studentId);

      if (!Number.isInteger(parsedStudentId) || parsedStudentId <= 0) {
        return NextResponse.json(
          { error: "Invalid student ID" },
          { status: 400 }
        );
      }

      where = sql`${attendance.studentId} = ${parsedStudentId}`;
    } else if (classId) {
      const parsedClassId = Number(classId);
      const parsedSectionId = sectionId ? Number(sectionId) : null;

      if (!Number.isInteger(parsedClassId) || parsedClassId <= 0) {
        return NextResponse.json(
          { error: "Invalid class ID" },
          { status: 400 }
        );
      }

      if (
        parsedSectionId !== null &&
        (!Number.isInteger(parsedSectionId) || parsedSectionId <= 0)
      ) {
        return NextResponse.json(
          { error: "Invalid section ID" },
          { status: 400 }
        );
      }

      where = sql`
        ${attendance.studentId} in (
          select student_id
          from enrollments
          where class_id = ${parsedClassId}
          and school_id = ${schoolId}
          and status = 'active'
          ${
            parsedSectionId
              ? sql`and section_id = ${parsedSectionId}`
              : sql``
          }
        )
      `;
    }

    const rows = await db
      .select({
        student: students.name,
        date: attendance.attDate,
        status: attendance.status,
      })
      .from(attendance)
      .innerJoin(students, and(eq(students.id, attendance.studentId), eq(students.schoolId, schoolId)))
      .where(and(where, eq(attendance.schoolId, schoolId)))
      .orderBy(attendance.attDate)
      .limit(20000);

    return csvResponse(
      toCsv(
        ["Student", "Date", "Status"],
        rows.map((r) => [r.student, r.date, r.status])
      ),
      "attendance.csv"
    );
  }

  if (type === "results") {
    const scale = await getScale(schoolId);

    const [exam] = await db
      .select()
      .from(examinations)
      .where(and(eq(examinations.status, "published"), eq(examinations.schoolId, schoolId)))
      .orderBy(sql`coalesce(end_date, start_date) desc`)
      .limit(1);

    if (!exam) {
      return csvResponse(
        toCsv(["No results published"], []),
        "results.csv"
      );
    }

    const clsList = await db
      .select()
      .from(classes)
      .where(eq(classes.schoolId, schoolId))
      .orderBy(classes.sortOrder);

    const out: unknown[][] = [];

    for (const c of clsList) {
      const res = await computeClassResults(exam.id, c.id, scale, schoolId);

      if (res.length === 0) continue;

      const subjects = Array.from(
        new Set(res.flatMap((x) => x.rows.map((y) => y.subjectName)))
      );

      out.push([
        c.name,
        exam.name,
        ...subjects.map((s) => `${s} (total)`),
        "Overall %",
        "GPA",
        "Result",
      ]);

      for (const r of res) {
        out.push([
          c.name,
          exam.name,
          ...subjects.map(
            (s) => r.rows.find((y) => y.subjectName === s)?.total ?? ""
          ),
          r.pct ?? "",
          r.gpaDisplay,
          r.result,
        ]);
      }

      out.push([]);
    }

    return csvResponse(
      out.map((row) => row.map(csvEscape).join(",")).join("\n"),
      "results.csv"
    );
  }

  return NextResponse.json({ error: "Unknown export type" }, { status: 400 });
}

export async function POST(req: Request) {
  const user = await getSessionUser();

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Admin only" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const schoolId = await currentSchoolId();

  const url = new URL(req.url);

  if (url.searchParams.get("op") !== "restore") {
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  }

  const fd = await req.formData();
  const file = fd.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "No backup file provided." },
      { status: 400 }
    );
  }

  let payload: any;

  try {
    payload = JSON.parse(await file.text());
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON backup file." },
      { status: 400 }
    );
  }

  if (payload?.app !== "sjjs-sms" || !payload.data || typeof payload.data !== "object") {
    return NextResponse.json(
      { error: "This file is not a SJJS SMS backup." },
      { status: 400 }
    );
  }

  if (payload.schoolId !== undefined && Number(payload.schoolId) !== schoolId) {
    return NextResponse.json(
      { error: "This backup belongs to a different school." },
      { status: 400 }
    );
  }

  // Tenant tables in foreign-key order. Every delete and insert is scoped to
  // the signed-in admin's school, so other schools are never touched.
  const tenantTables: [string, any][] = [
    ["academic_years", academicYears],
    ["classes", classes],
    ["sections", sections],
    ["subjects", subjects],
    ["students", students],
    ["teachers", teachers],
    ["users", users],
    ["parent_children", parentChildren],
    ["class_subjects", classSubjects],
    ["enrollments", enrollments],
    ["attendance", attendance],
    ["examinations", examinations],
    ["exam_subjects", examSubjects],
    ["marks", marks],
    ["notes", notes],
    ["notices", notices],
    ["grading_scale", gradingScale],
    ["audit_logs", auditLogs],
    ["fee_categories", feeCategories],
    ["fee_structures", feeStructures],
    ["fee_invoices", feeInvoices],
    ["fee_invoice_items", feeInvoiceItems],
    ["fee_payments", feePayments],
  ];

  // A partial backup would orphan rows, so every tenant table must be present.
  const missing = tenantTables
    .map(([name]) => name)
    .filter((name) => !Array.isArray(payload.data[name]));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Backup is incomplete. Missing: ${missing.join(", ")}.` },
      { status: 400 }
    );
  }

  const prepared: [string, any, Record<string, unknown>[]][] = [];
  try {
    for (const [name, table] of tenantTables) {
      const rows = (payload.data[name] as unknown[]).map((raw) =>
        prepareRow(table, raw, schoolId, name)
      );
      // The platform owner account is managed outside school restores.
      prepared.push([
        name,
        table,
        name === "users"
          ? rows.filter((r) => r.id !== PLATFORM_OWNER_USER_ID)
          : rows,
      ]);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid backup rows." },
      { status: 400 }
    );
  }

  const settingRows = Array.isArray(payload.data.settings)
    ? (payload.data.settings as { key?: unknown; value?: unknown }[])
        .filter((r) => typeof r?.key === "string" && isTenantSettingKey(r.key, schoolId))
        .map((r) => ({ key: r.key as string, value: r.value == null ? null : String(r.value) }))
    : [];

  const schoolUserIds = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.schoolId, schoolId));

  const operations: any[] = [
    db.delete(sessions).where(inArray(sessions.userId, schoolUserIds)),
  ];

  for (const [name, table] of [...tenantTables].reverse()) {
    operations.push(
      name === "users"
        ? db.delete(users).where(and(eq(users.schoolId, schoolId), ne(users.id, PLATFORM_OWNER_USER_ID)))
        : db.delete(table).where(eq(table.schoolId, schoolId))
    );
  }

  for (const [, table, rows] of prepared) {
    for (let k = 0; k < rows.length; k += 500) {
      operations.push(db.insert(table).values(rows.slice(k, k + 500) as any));
    }
  }

  for (const row of settingRows) {
    operations.push(
      db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: { value: row.value } })
    );
  }

  // Restore serial counters after explicit IDs are inserted from the backup.
  const sequenceTables = [
    "academic_years", "classes", "sections", "subjects", "students", "teachers",
    "users", "parent_children", "class_subjects", "enrollments", "attendance",
    "examinations", "exam_subjects", "marks", "notes", "notices", "grading_scale",
    "audit_logs", "fee_categories", "fee_structures", "fee_invoices",
    "fee_invoice_items", "fee_payments", "sessions",
  ];
  for (const tableName of sequenceTables) {
    operations.push(db.execute(sql.raw(
      `SELECT setval(pg_get_serial_sequence('"${tableName}"', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM "${tableName}"`
    )));
  }

  // Neon HTTP batch executes the statements as one database transaction:
  // any failure (for example an id owned by another school) rolls it all back.
  try {
    await db.batch(operations as any);
  } catch (error) {
    console.error("Restore failed", error);
    return NextResponse.json(
      { error: "Restore failed and nothing was changed. The backup may not match this school." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const tables = tenantTables.length;

  return NextResponse.json(
    { ok: true, tables },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
