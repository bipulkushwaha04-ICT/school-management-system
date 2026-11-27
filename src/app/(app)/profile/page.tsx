import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { users, students } from "@/db/schema";
import { requireUser, logAudit } from "@/lib/auth";
import { currentSchoolId } from "@/lib/tenant";
import { flashTo, changePassword, logout } from "@/actions/auth";
import { fmtDate } from "@/lib/grading";
import { PageHead, Badge, Field, Icon } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function saveMyProfile(formData: FormData) {
  "use server";
  const user = await requireUser();
  const schoolId = await currentSchoolId();
  if (user.role === "student") {
    const studentId = user.studentId!;
    await db
      .update(students)
      .set({
        contact: s(formData.get("contact")),
        address: s(formData.get("address")),
        email: s(formData.get("email")),
      })
      .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)));
    await logAudit(user.id, "Updated own profile", "student", studentId);
    await flashTo("/profile", "Profile updated.");
  } else {
    const rawEmail = s(formData.get("email"));
    const email = rawEmail ? rawEmail.toLowerCase() : user.email;
    if (email !== user.email) {
      const duplicate = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.id, user.id), eq(users.schoolId, schoolId)))
        .limit(1);
      if (duplicate.length > 0) {
        await flashTo("/profile", "That email address is already in use.", true);
        return;
      }
    }
    await db
      .update(users)
      .set({ email })
      .where(and(eq(users.id, user.id), eq(users.schoolId, schoolId)));
    await logAudit(user.id, "Updated own profile", "user", user.id);
    await flashTo("/profile", "Profile updated.");
  }
}

function s(v: FormDataEntryValue | null) {
  const str = String(v ?? "").trim();
  return str ? str : null;
}

const roleLabel: Record<string, string> = {
  admin: "Administrator",
  teacher: "Teacher",
  student: "Student",
  parent: "Parent / Guardian",
};

export default async function ProfilePage() {
  const user = await requireUser();
  const schoolId = await currentSchoolId();
  const [me] = await db.select().from(users).where(and(eq(users.id, user.id), eq(users.schoolId, schoolId))).limit(1);
  let student: any = null;
  if (user.role === "student") {
    [student] = await db.select().from(students).where(and(eq(students.id, user.studentId!), eq(students.schoolId, schoolId))).limit(1);
  }

  return (
    <>
      <PageHead title="My Profile" sub="Account details and security" />

      <div className="grid lg:grid-cols-2 gap-3.5">
        <div className="card p-5">
          <div className="flex items-center gap-4 mb-5">
            <span className="w-14 h-14 rounded-2xl bg-forest text-white flex items-center justify-center text-xl font-extrabold">{user.name[0]}</span>
            <div>
              <div className="font-bold text-ink text-lg">{user.name}</div>
              <div className="flex items-center gap-2 mt-1">
                <Badge tone="green">{roleLabel[user.role]}</Badge>
                {me?.lastLoginAt && <span className="text-[11px] text-muted">Last login {fmtDate(me.lastLoginAt)}</span>}
              </div>
            </div>
          </div>

          <form action={saveMyProfile} className="space-y-3.5">
            <Field label="Email">
              <input name="email" type="email" defaultValue={user.email} className="inp" required />
            </Field>
            {student && (
              <>
                <Field label="Contact number">
                  <input name="contact" defaultValue={student.contact ?? ""} className="inp" />
                </Field>
                <Field label="Address">
                  <input name="address" defaultValue={student.address ?? ""} className="inp" />
                </Field>
              </>
            )}
            <div className="flex items-center justify-between pt-1">
              <button type="submit" className="btn-primary"><Icon name="check" className="w-4 h-4" /> Save profile</button>
              <form action={logout}>
                <button className="btn-danger"><Icon name="logout" className="w-4 h-4" /> Sign out</button>
              </form>
            </div>
          </form>
        </div>

        <div className="card p-5">
          <h3 className="font-bold text-sm text-ink mb-1">Change password</h3>
          <p className="text-xs text-muted mb-4">Minimum 6 characters. Your session stays active after changing it.</p>
          <form action={changePassword} className="space-y-3.5">
            <Field label="Current password">
              <input name="current" type="password" required autoComplete="current-password" className="inp" />
            </Field>
            <Field label="New password">
              <input name="next" type="password" required minLength={8} autoComplete="new-password" className="inp" />
            </Field>
            <Field label="Confirm new password">
              <input name="confirm" type="password" required minLength={8} autoComplete="new-password" className="inp" />
            </Field>
            <button className="btn-primary"><Icon name="lock" className="w-4 h-4" /> Update password</button>
          </form>

          <div className="mt-5 rounded-lg bg-forest-mist/60 border border-linesoft p-3.5 text-xs text-inksoft leading-relaxed">
            <span className="font-bold text-forest">Security:</span> passwords are stored as salted scrypt hashes, sessions
            expire automatically after 7 days, and every administrative action is written to the audit log.
          </div>
        </div>
      </div>
    </>
  );
}
