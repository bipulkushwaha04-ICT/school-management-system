import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { schools, users } from "@/db/schema";
import {
  createSchoolAdmin,
  revokeUserSessions,
  setUserActive,
} from "@/actions/platform";
import { Avatar, Badge, Empty, Field, FormModal, Icon, ModalCancel, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PlatformUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = String(sp.q ?? "").trim().toLowerCase();
  const role = String(sp.role ?? "all");
  const schoolId = Number(sp.school ?? 0) || 0;

  const [allUsers, allSchools] = await Promise.all([
    db.select().from(users).orderBy(desc(users.createdAt)),
    db.select({ id: schools.id, name: schools.name }).from(schools).orderBy(schools.name),
  ]);
  const filtered = allUsers.filter((user) => {
    const matchesQuery = !q || user.name.toLowerCase().includes(q) || user.email.toLowerCase().includes(q);
    const matchesRole = role === "all" || user.role === role;
    const matchesSchool = !schoolId || user.schoolId === schoolId;
    return matchesQuery && matchesRole && matchesSchool;
  });

  return (
    <div className="space-y-6">
      <PageHead title="Users" sub="Platform-wide accounts, status and sessions.">
        <FormModal title="Create school administrator" icon="plus" label="Create admin">
          <form action={createSchoolAdmin} className="space-y-4">
            <Field label="School">
              <select name="schoolId" required className="inp">
                {allSchools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
              </select>
            </Field>
            <Field label="Name"><input name="name" required className="inp" /></Field>
            <Field label="Email"><input name="email" type="email" required className="inp" /></Field>
            <Field label="Temporary password"><input name="password" type="password" minLength={8} required className="inp" /></Field>
            <div className="flex justify-end gap-2">
              <ModalCancel />
              <button className="btn-primary btn-sm" type="submit">Create account</button>
            </div>
          </form>
        </FormModal>
      </PageHead>

      <form method="get" className="card grid gap-2.5 p-3.5 sm:grid-cols-[1fr_150px_170px_auto]">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" />
          <input name="q" defaultValue={String(sp.q ?? "")} placeholder="Search name or email" className="inp pl-9" />
        </div>
        <select name="role" defaultValue={role} className="inp">
          <option value="all">All roles</option>
          {["admin", "teacher", "student", "parent"].map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select name="school" defaultValue={String(schoolId)} className="inp">
          <option value="0">All schools</option>
          {allSchools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
        </select>
        <button className="btn-ghost btn-sm" type="submit">Filter</button>
      </form>

      <section className="card overflow-hidden">
        {filtered.length === 0 ? <Empty icon="users" title="No accounts found" /> : (
          <div className="overflow-x-auto">
            <table className="tbl min-w-[900px]">
              <thead><tr><th>Account</th><th>Role</th><th>School</th><th>Status</th><th>Last sign in</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                {filtered.map((user) => {
                  const school = allSchools.find((s) => s.id === user.schoolId);
                  return (
                    <tr key={user.id}>
                      <td><div className="flex items-center gap-2"><Avatar name={user.name} className="h-8 w-8 text-[11px]" /><div><div className="font-semibold">{user.name}</div><div className="text-xs text-muted">{user.email}</div></div></div></td>
                      <td><Badge>{user.role}</Badge></td>
                      <td className="text-xs text-inksoft">{school?.name ?? `School ${user.schoolId}`}</td>
                      <td><Badge tone={user.isActive ? "green" : "red"}>{user.isActive ? "Active" : "Inactive"}</Badge></td>
                      <td className="text-xs text-inksoft">{user.lastLoginAt ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(user.lastLoginAt) : "—"}</td>
                      <td className="text-xs text-inksoft">{new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(user.createdAt)}</td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {user.id !== 1 && (
                            <form action={setUserActive}>
                              <input type="hidden" name="id" value={user.id} />
                              <input type="hidden" name="active" value={String(!user.isActive)} />
                              <button className="btn-ghost btn-sm" type="submit">{user.isActive ? "Deactivate" : "Activate"}</button>
                            </form>
                          )}
                          <form action={revokeUserSessions}>
                            <input type="hidden" name="id" value={user.id} />
                            <button className="btn-ghost btn-sm" type="submit">Revoke sessions</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
