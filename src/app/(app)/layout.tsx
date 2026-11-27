
import Sidebar, { NavItem } from "@/components/Sidebar";
import { Flash } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getSchool } from "@/lib/grading";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const school = await getSchool(user.schoolId ?? 1);

  let items: NavItem[];

  if (user.role === "admin") {
    items = [
      { label: "Dashboard", href: "/dashboard", icon: "grid", section: "Overview" },
      { label: "Students", href: "/students", icon: "cap", section: "Academics" },
      { label: "Teachers", href: "/teachers", icon: "users", section: "Academics" },
      { label: "User Management", href: "/users", icon: "users", section: "Administration" },
      { label: "Classes & Subjects", href: "/classes", icon: "book", section: "Academics" },
      { label: "Subjects", href: "/subjects", icon: "book", section: "Academics" },
      { label: "Academic Years", href: "/academic-years", icon: "calendar", section: "Academics" },
      { label: "Promotion", href: "/promotion", icon: "arrow", section: "Academics" },
      { label: "Attendance", href: "/attendance", icon: "clipboard", section: "Daily" },
      { label: "Examinations", href: "/examinations", icon: "calendar", section: "Examinations" },
      { label: "Mark Entry", href: "/marks", icon: "pen", section: "Examinations" },
      { label: "Results", href: "/results", icon: "file", section: "Examinations" },
      { label: "Notes & Materials", href: "/notes", icon: "folder", section: "Resources" },
      { label: "Notices", href: "/notices", icon: "bell", section: "Resources" },
      { label: "Fee Management", href: "/fees", icon: "file", section: "Administration" },
      { label: "Reports", href: "/reports", icon: "chart", section: "Administration" },
      { label: "Activity Log", href: "/activity", icon: "activity", section: "Administration" },
      { label: "Settings", href: "/settings", icon: "gear", section: "Administration" },
    ];
  } else if (user.role === "teacher") {
    items = [
      { label: "Dashboard", href: "/dashboard", icon: "grid", section: "Overview" },
      { label: "My Classes", href: "/classes", icon: "book", section: "Academics" },
      { label: "Class Fee Status", href: "/fees/class", icon: "file", section: "Academics" },
      { label: "Attendance", href: "/attendance", icon: "clipboard", section: "Daily" },
      { label: "Mark Entry", href: "/marks", icon: "pen", section: "Examinations" },
      { label: "Results", href: "/results", icon: "file", section: "Examinations" },
      { label: "Examinations", href: "/examinations", icon: "calendar", section: "Examinations" },
      { label: "Notes & Materials", href: "/notes", icon: "folder", section: "Resources" },
      { label: "Notices", href: "/notices", icon: "bell", section: "Resources" },
    ];
  } else if (user.role === "student") {
    items = [
      { label: "Dashboard", href: "/dashboard", icon: "grid", section: "Overview" },
      { label: "My Profile", href: `/students/${user.studentId}`, icon: "user", section: "My Records" },
      { label: "My Fees", href: "/fees", icon: "file", section: "My Records" },
      { label: "Attendance", href: "/attendance", icon: "clipboard", section: "My Records" },
      { label: "Results & Marksheets", href: "/results", icon: "file", section: "My Records" },
      { label: "Notes & Materials", href: "/notes", icon: "folder", section: "Resources" },
      { label: "Examination Routine", href: "/examinations", icon: "calendar", section: "Resources" },
      { label: "Notices", href: "/notices", icon: "bell", section: "Resources" },
    ];
  } else {
    items = [
      { label: "Dashboard", href: "/dashboard", icon: "grid", section: "Overview" },
      { label: "Attendance", href: "/attendance", icon: "clipboard", section: "My Children" },
      { label: "Results & Marksheets", href: "/results", icon: "file", section: "My Children" },
      { label: "Notes & Materials", href: "/notes", icon: "folder", section: "Resources" },
      { label: "Examination Routine", href: "/examinations", icon: "calendar", section: "Resources" },
      { label: "Notices", href: "/notices", icon: "bell", section: "Resources" },
    ];
  }

  // Make account profile and password settings available to every role.
  items.push({
    label: "My Profile & Password",
    href: "/profile",
    icon: "user",
    section: "Account",
  });

  return (
    <div className="flex min-h-screen flex-col lg:flex-row bg-paper">
      <Sidebar items={items} user={user} school={school} />
      <div className="flex-1 min-w-0 paper-bg">
        <main className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1400px]">
          {children}
        </main>
        <Flash />
      </div>
    </div>
  );
}

