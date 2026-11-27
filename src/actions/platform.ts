"use server";

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  platformSettings,
  schoolSubscriptions,
  schools,
  sessions,
  subscriptionPlans,
  users,
} from "@/db/schema";
import { flashTo } from "@/actions/auth";
import { logAudit } from "@/lib/auth";
import { requirePlatformAdmin, PLATFORM_OWNER_USER_ID } from "@/lib/platform-auth";
import { hashPassword } from "@/lib/password";

const text = (value: FormDataEntryValue | null) =>
  String(value ?? "").trim() || null;

export async function setUserActive(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = Number(formData.get("id"));
  const active = formData.get("active") === "true";
  if (!id || id === PLATFORM_OWNER_USER_ID) {
    await flashTo("/superadmin/users", "That account cannot be changed here.", true);
  }
  await db.update(users).set({ isActive: active }).where(eq(users.id, id));
  if (!active) await db.delete(sessions).where(eq(sessions.userId, id));
  await logAudit(admin.id, active ? "Account activated" : "Account deactivated", "user", id);
  await flashTo("/superadmin/users", active ? "Account activated." : "Account deactivated and sessions revoked.");
}

export async function revokeUserSessions(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = Number(formData.get("id"));
  if (!id) await flashTo("/superadmin/users", "Invalid account.", true);
  await db.delete(sessions).where(eq(sessions.userId, id));
  await logAudit(admin.id, "Sessions revoked", "user", id);
  await flashTo("/superadmin/users", "All active sessions for this account were revoked.");
}

export async function createSchoolAdmin(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const name = text(formData.get("name"));
  const email = text(formData.get("email"))?.toLowerCase();
  const password = String(formData.get("password") ?? "");
  const schoolId = Number(formData.get("schoolId"));
  if (!name || !email || !schoolId || password.length < 8) {
    await flashTo("/superadmin/users", "Name, school, email and a password of at least 8 characters are required.", true);
  }
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email!)).limit(1);
  if (existing) await flashTo("/superadmin/users", "That email is already registered.", true);

  await db.insert(users).values({
    schoolId,
    name: name!,
    email: email!,
    passwordHash: hashPassword(password),
    role: "admin",
    isActive: true,
  });
  await logAudit(admin.id, "School administrator created", "user", undefined, `${name!} · school ${schoolId}`);
  await flashTo("/superadmin/users", "School administrator created.");
}

export async function savePlan(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = Number(formData.get("id"));
  const name = text(formData.get("name"));
  const slug = text(formData.get("slug"))?.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!name || !slug) await flashTo("/superadmin/plans", "Plan name and slug are required.", true);

  const monthly = Math.max(0, Math.round(Number(formData.get("monthlyNpr")) || 0) * 100);
  const annual = Math.max(0, Math.round(Number(formData.get("annualNpr")) || 0) * 100);
  const limitRaw = text(formData.get("studentLimit"));
  const values = {
    name: name!,
    slug: slug!,
    description: text(formData.get("description")),
    monthlyPaisa: monthly,
    annualPaisa: annual,
    studentLimit: limitRaw ? Math.max(1, Number(limitRaw)) : null,
    features: text(formData.get("features")),
    isActive: formData.get("isActive") === "on",
    sortOrder: Number(formData.get("sortOrder")) || 0,
    updatedAt: new Date(),
  };

  const conflict = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans)
    .where(id ? and(eq(subscriptionPlans.slug, slug!), ne(subscriptionPlans.id, id)) : eq(subscriptionPlans.slug, slug!)).limit(1);
  if (conflict.length) await flashTo("/superadmin/plans", "That plan slug already exists.", true);

  if (id) await db.update(subscriptionPlans).set(values).where(eq(subscriptionPlans.id, id));
  else await db.insert(subscriptionPlans).values(values);
  await logAudit(admin.id, id ? "Plan updated" : "Plan created", "plan", id || undefined, name!);
  await flashTo("/superadmin/plans", id ? "Plan saved." : "Plan created.");
}

export async function togglePlan(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const id = Number(formData.get("id"));
  const isActive = formData.get("isActive") === "true";
  if (!id) await flashTo("/superadmin/plans", "Invalid plan.", true);
  await db.update(subscriptionPlans).set({ isActive, updatedAt: new Date() }).where(eq(subscriptionPlans.id, id));
  await logAudit(admin.id, isActive ? "Plan activated" : "Plan deactivated", "plan", id);
  await flashTo("/superadmin/plans", isActive ? "Plan activated." : "Plan deactivated.");
}

export async function assignSubscription(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const schoolId = Number(formData.get("schoolId"));
  const planId = Number(formData.get("planId"));
  const status = String(formData.get("status") ?? "active");
  if (!schoolId || !planId || !["active", "trial", "suspended", "expired"].includes(status)) {
    await flashTo("/superadmin/subscriptions", "Select a school, plan and valid status.", true);
  }
  const dateValue = (key: string) => {
    const raw = text(formData.get(key));
    if (!raw) return null;
    const parsed = new Date(`${raw}T23:59:59Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const values = {
    schoolId,
    planId,
    status,
    expiresAt: dateValue("expiresAt"),
    trialEndsAt: dateValue("trialEndsAt"),
    updatedAt: new Date(),
  };
  const [existing] = await db.select({ id: schoolSubscriptions.id }).from(schoolSubscriptions).where(eq(schoolSubscriptions.schoolId, schoolId)).limit(1);
  if (existing) await db.update(schoolSubscriptions).set(values).where(eq(schoolSubscriptions.id, existing.id));
  else await db.insert(schoolSubscriptions).values(values);
  await logAudit(admin.id, "Subscription assigned", "school", schoolId, `plan ${planId} · ${status}`);
  await flashTo("/superadmin/subscriptions", "Subscription saved.");
}

export async function savePlatformSettings(formData: FormData) {
  const admin = await requirePlatformAdmin();
  const keys = [
    "platform_name", "platform_email", "platform_contact", "default_currency",
    "registration_enabled", "school_approval_required", "maintenance_mode", "email_configured",
  ];
  for (const key of keys) {
    const value = key.endsWith("_enabled") || key === "maintenance_mode"
      ? String(formData.get(key) === "on")
      : text(formData.get(key)) ?? "";
    await db.insert(platformSettings).values({ key, value })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
  }
  await logAudit(admin.id, "Platform settings updated", "settings");
  await flashTo("/superadmin/settings", "Platform settings saved.");
}
