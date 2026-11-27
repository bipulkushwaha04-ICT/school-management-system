import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, schools, schoolSubscriptions, subscriptionPlans, users } from "@/db/schema";
import { getPlatformAdminUser } from "@/lib/platform-auth";
import { toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";

const csv = (header: string[], rows: unknown[][]) => toCsv(header, rows);

export async function GET(request: Request) {
  const admin = await getPlatformAdminUser();
  if (!admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const type = new URL(request.url).searchParams.get("type") ?? "schools";

  let body: string;
  let filename: string;

  if (type === "users") {
    const rows = await db.select({
      id: users.id, name: users.name, email: users.email, role: users.role,
      schoolId: users.schoolId, active: users.isActive,
      lastLogin: users.lastLoginAt, created: users.createdAt,
    }).from(users).orderBy(desc(users.createdAt));
    body = csv(["ID", "Name", "Email", "Role", "School ID", "Active", "Last login", "Created"],
      rows.map((r) => [r.id, r.name, r.email, r.role, r.schoolId, r.active, r.lastLogin, r.created]));
    filename = "platform-users.csv";
  } else if (type === "subscriptions") {
    const rows = await db.select({
      school: schools.name, plan: subscriptionPlans.name, status: schoolSubscriptions.status,
      starts: schoolSubscriptions.startsAt, expires: schoolSubscriptions.expiresAt,
    }).from(schoolSubscriptions)
      .innerJoin(schools, eq(schools.id, schoolSubscriptions.schoolId))
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, schoolSubscriptions.planId))
      .orderBy(desc(schoolSubscriptions.createdAt));
    body = csv(["School", "Plan", "Status", "Starts", "Expires"],
      rows.map((r) => [r.school, r.plan, r.status, r.starts, r.expires]));
    filename = "platform-subscriptions.csv";
  } else if (type === "activity") {
    const rows = await db.select({
      id: auditLogs.id, action: auditLogs.action, entity: auditLogs.entity,
      details: auditLogs.details, schoolId: auditLogs.schoolId, created: auditLogs.createdAt,
    }).from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(1000);
    body = csv(["ID", "Action", "Entity", "Details", "School ID", "Created"],
      rows.map((r) => [r.id, r.action, r.entity, r.details, r.schoolId, r.created]));
    filename = "platform-activity.csv";
  } else {
    const rows = await db.select().from(schools).orderBy(desc(schools.createdAt));
    body = csv(["ID", "Name", "Code", "Registration", "Province", "District", "Status", "Approval", "Created"],
      rows.map((r) => [r.id, r.name, r.code, r.registrationNo, r.province, r.district, r.status, r.approvalStatus, r.createdAt]));
    filename = "platform-schools.csv";
  }

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
