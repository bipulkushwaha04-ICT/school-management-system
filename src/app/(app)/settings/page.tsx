
import Image from "next/image";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { settings as settingsTable, gradingScale, schools } from "@/db/schema";
import { requireRole, logAudit } from "@/lib/auth";
import { flashTo } from "@/actions/auth";
import { DEFAULT_SCALE, getSchool, settingKey } from "@/lib/grading";
import { currentSchoolId } from "@/lib/tenant";
import { PageHead, Icon, Field, Badge } from "@/components/ui";
import { RestoreForm } from "./RestoreForm";

export const dynamic = "force-dynamic";

async function upsertSetting(schoolId: number, key: string, value: string) {
  const scopedKey = settingKey(schoolId, key);
  await db
    .insert(settingsTable)
    .values({ key: scopedKey, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

const MAX_TEXT = 200;

export async function saveSchoolSettings(formData: FormData) {
  "use server";

  const user = await requireRole("admin");
  const schoolId = await currentSchoolId();

  const read = (name: string) => String(formData.get(name) ?? "").trim().slice(0, MAX_TEXT);
  const name = read("name");
  const email = read("email");
  const logoUrl = read("logoUrl");
  const minAttendanceRaw = read("minAttendance");
  const minAttendance = minAttendanceRaw === "" ? null : Number(minAttendanceRaw);

  if (!name) {
    await flashTo("/settings", "School name is required.", true);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await flashTo("/settings", "Enter a valid school email address.", true);
  }
  if (logoUrl && !(logoUrl.startsWith("/") && !logoUrl.startsWith("//")) && !/^https:\/\//i.test(logoUrl)) {
    await flashTo("/settings", "Logo URL must be a site path like /images/logo.png or an https:// link.", true);
  }
  if (minAttendance !== null && (!Number.isFinite(minAttendance) || minAttendance < 0 || minAttendance > 100)) {
    await flashTo("/settings", "Minimum attendance must be between 0 and 100.", true);
  }

  const map: [string, string][] = [
    ["school_name", name],
    ["school_name_np", read("nameNp")],
    ["school_address", read("address")],
    ["school_contact", read("contact")],
    ["school_email", email],
    ["school_website", read("website")],
    ["school_logo", logoUrl],
    ["principal_name", read("principal")],
    ["min_attendance", minAttendance === null ? "" : String(minAttendance)],
  ];

  // Saving an emptied field clears it, so stale values never linger.
  for (const [k, v] of map) await upsertSetting(schoolId, k, v);

  // Keep the tenant record (used by the platform console) in step.
  await db
    .update(schools)
    .set({
      name,
      nameNp: read("nameNp") || null,
      address: read("address") || null,
      phone: read("contact") || null,
      contactEmail: email || null,
      principalName: read("principal") || null,
      logoUrl: logoUrl || null,
      updatedAt: new Date(),
    })
    .where(eq(schools.id, schoolId));

  await logAudit(user.id, "Updated school settings", "settings");
  await flashTo("/settings", "School settings saved.");
}

export async function saveScaleRow(formData: FormData) {
  "use server";

  const user = await requireRole("admin");
  const schoolId = await currentSchoolId();

  const id = Number(formData.get("id") ?? 0);
  const grade = String(formData.get("grade") ?? "").trim().slice(0, 5);
  const minPct = Number(formData.get("minPct"));
  const maxPct = Number(formData.get("maxPct"));
  const points10 = Number(formData.get("points10"));
  const isFail = formData.get("isFail") === "on";
  const sortOrder = Number(formData.get("sortOrder") || 0);

  const valid =
    grade &&
    Number.isInteger(id) && id >= 0 &&
    Number.isFinite(minPct) && Number.isFinite(maxPct) &&
    minPct >= 0 && maxPct <= 100 && minPct <= maxPct &&
    Number.isInteger(points10) && points10 >= 0 && points10 <= 40 &&
    Number.isInteger(sortOrder);

  if (!valid) {
    await flashTo("/settings", "Invalid scale row: check the grade, a 0 to 100 range and grade points of 0 to 4.0.", true);
    return;
  }

  const values = { grade, minPct, maxPct, points10, isFail, sortOrder };
  if (id > 0) {
    const updated = await db
      .update(gradingScale)
      .set(values)
      .where(and(eq(gradingScale.id, id), eq(gradingScale.schoolId, schoolId)))
      .returning({ id: gradingScale.id });
    if (updated.length === 0) {
      await flashTo("/settings", "That grading row was not found.", true);
    }
  } else {
    // First edit on a school still using the default scale: materialise it.
    const existing = await db
      .select({ id: gradingScale.id })
      .from(gradingScale)
      .where(eq(gradingScale.schoolId, schoolId))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(gradingScale).values(
        DEFAULT_SCALE.map((r, i) => ({ ...r, sortOrder: i + 1, schoolId })),
      );
    }
    await db
      .insert(gradingScale)
      .values({ ...values, schoolId })
      .onConflictDoUpdate({
        target: [gradingScale.schoolId, gradingScale.grade],
        set: values,
      });
  }

  await logAudit(
    user.id,
    "Updated grading scale",
    "gradingScale",
    undefined,
    `${grade}: ${minPct}-${maxPct}% → ${(points10 / 10).toFixed(1)}`
  );

  await flashTo(
    "/settings",
    "Grading scale updated. New results will use the revised rules."
  );
}

export default async function SettingsPage() {
  await requireRole("admin");
  const schoolId = await currentSchoolId();

  const school = await getSchool(schoolId);
  const savedScale = await db
    .select()
    .from(gradingScale)
    .where(eq(gradingScale.schoolId, schoolId))
    .orderBy(gradingScale.sortOrder);
  // Schools without their own scale see (and can edit) the default one.
  const scale = savedScale.length > 0
    ? savedScale
    : DEFAULT_SCALE.map((r, i) => ({ ...r, id: 0, sortOrder: i + 1 }));

  const logoUrl = school.logoUrl || "/images/emblem.png";

  return (
    <>
      <PageHead
        title="School Settings"
        sub="Identity, grading rules and data safety"
      />

      <div className="grid lg:grid-cols-2 gap-3.5">
        <div className="card p-5">
          <h3 className="font-bold text-sm text-ink mb-4">
            School information
          </h3>

          <form action={saveSchoolSettings} className="space-y-3.5">
            <div className="flex items-center gap-4 mb-2">
              <Image
                src={logoUrl}
                alt="School logo"
                width={56}
                height={56}
                className="w-14 h-14 rounded-full border border-line object-contain bg-white"
                unoptimized
              />

              <div className="text-xs text-muted leading-relaxed">
                The logo appears in the sidebar, login screen and printed marksheets.
              </div>
            </div>

            <Field label="School name (English)">
              <input name="name" defaultValue={school.name} className="inp" />
            </Field>

            <Field label="School name (Nepali)">
              <input
                name="nameNp"
                defaultValue={school.nameNp}
                className="inp font-deva"
              />
            </Field>

            <Field label="Address">
              <input
                name="address"
                defaultValue={school.address}
                className="inp"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact number">
                <input
                  name="contact"
                  defaultValue={school.contact}
                  className="inp"
                />
              </Field>

              <Field label="Email">
                <input
                  name="email"
                  defaultValue={school.email}
                  className="inp"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Website">
                <input
                  name="website"
                  defaultValue={school.website}
                  className="inp"
                />
              </Field>

              <Field label="Head teacher name">
                <input
                  name="principal"
                  defaultValue={school.principalName}
                  className="inp"
                />
              </Field>
            </div>

            <Field label="Logo URL (optional)">
              <input
                name="logoUrl"
                defaultValue={school.logoUrl ?? "/images/emblem.png"}
                className="inp"
                placeholder="/images/emblem.png"
              />
            </Field>

            <Field label="Minimum attendance % for promotion">
              <input
                name="minAttendance"
                type="number"
                min="50"
                max="100"
                defaultValue={school.minAttendance}
                className="inp"
              />
            </Field>

            <button className="btn-primary">
              <Icon name="check" className="w-4 h-4" />
              Save settings
            </button>
          </form>
        </div>

        <div className="space-y-3.5">
          <div className="card overflow-hidden">
            <div className="px-5 pt-4 pb-2">
              <h3 className="font-bold text-sm text-ink">
                Nepal government grading scale
              </h3>

              <p className="text-xs text-muted mt-0.5">
                Edit ranges or grade points — used automatically for every result.
                Save each row after editing.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Grade</th>
                    <th>Min %</th>
                    <th>Max %</th>
                    <th>Points</th>
                    <th>Fail</th>
                    <th className="text-right">Save</th>
                  </tr>
                </thead>

                <tbody>
                  {scale.map((g) => (
                    <tr key={`${g.id}-${g.grade}`}>
                      <td className="px-0">
                        <form
                          action={saveScaleRow}
                          className="flex items-center gap-1.5"
                        >
                          <input
                            type="hidden"
                            name="id"
                            value={g.id}
                          />

                          <input
                            type="hidden"
                            name="sortOrder"
                            value={g.sortOrder}
                          />

                          <input
                            name="grade"
                            defaultValue={g.grade}
                            className="inp w-14 text-center font-bold"
                          />

                          <input
                            name="minPct"
                            type="number"
                            defaultValue={g.minPct}
                            className="inp w-16 text-center"
                          />

                          <input
                            name="maxPct"
                            type="number"
                            defaultValue={g.maxPct}
                            className="inp w-16 text-center"
                          />

                          <input
                            name="points10"
                            type="number"
                            step="1"
                            min="0"
                            max="40"
                            defaultValue={g.points10}
                            className="inp w-16 text-center"
                            title="Grade point × 10"
                          />

                          <input
                            type="checkbox"
                            name="isFail"
                            defaultChecked={g.isFail}
                            className="accent-danger w-4 h-4"
                            title="Failing grade"
                          />

                          <button
                            className="btn-ghost btn-sm ml-1"
                            title="Save row"
                          >
                            <Icon name="check" className="w-3.5 h-3.5" />
                          </button>
                        </form>
                      </td>

                      <td
                        colSpan={5}
                        className="text-[10px] text-muted -mt-1.5"
                      >
                        {g.isFail
                          ? "Below this band students fail the subject."
                          : `Grade point ${(g.points10 / 10).toFixed(1)} of 4.0`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="font-bold text-sm text-ink mb-1">
              Data backup & restore
            </h3>

            <p className="text-xs text-muted mb-3">
              Download a complete JSON backup of every table, or restore from
              a previously downloaded backup. Restoring replaces all current
              data — take a fresh backup first.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <a href="/api/data?op=backup" className="btn-primary">
                <Icon name="download" className="w-4 h-4" />
                Download backup
              </a>

              <RestoreForm />

              <Badge tone="gray">PostgreSQL · drizzle</Badge>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
