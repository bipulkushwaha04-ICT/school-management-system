import assert from "node:assert/strict";
import test from "node:test";

process.env.TZ = "Asia/Kathmandu";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost/test";

const { gradeFor, addDays, todayStr, fmtDate } = await import("../src/lib/grading");

const scale = [
  { grade: "A+", minPct: 90, maxPct: 100, points10: 40, isFail: false },
  { grade: "A", minPct: 85, maxPct: 89, points10: 36, isFail: false },
  { grade: "B+", minPct: 80, maxPct: 84, points10: 32, isFail: false },
  { grade: "E", minPct: 40, maxPct: 54, points10: 8, isFail: false },
  { grade: "F", minPct: 0, maxPct: 39, points10: 0, isFail: true },
];

test("gradeFor maps whole-number bands", () => {
  assert.deepEqual(gradeFor(90, scale), { grade: "A+", points10: 40, fail: false });
  assert.deepEqual(gradeFor(89, scale), { grade: "A", points10: 36, fail: false });
  assert.deepEqual(gradeFor(80, scale), { grade: "B+", points10: 32, fail: false });
  assert.deepEqual(gradeFor(39, scale), { grade: "F", points10: 0, fail: true });
});

test("gradeFor handles fractional percentages inside integer bands", () => {
  assert.deepEqual(gradeFor(89.5, scale), { grade: "A", points10: 36, fail: false });
  assert.deepEqual(gradeFor(84.9, scale), { grade: "B+", points10: 32, fail: false });
  assert.deepEqual(gradeFor(39.9, scale), { grade: "F", points10: 0, fail: true });
});

test("gradeFor falls back safely with no passing band or no scale", () => {
  assert.deepEqual(gradeFor(75, [scale[4]]), { grade: "F", points10: 0, fail: true });
  assert.deepEqual(gradeFor(75, []), { grade: "F", points10: 0, fail: true });
});

test("addDays returns the local calendar date", () => {
  const localMidnight = new Date(2026, 10, 23, 0, 0, 0);
  assert.equal(addDays(localMidnight, 1), "2026-11-24");
  assert.equal(addDays(localMidnight, 0), "2026-11-23");
  assert.equal(addDays(localMidnight, -1), "2026-11-22");
});

test("todayStr uses the local calendar date even before the UTC day flips", () => {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(value?: string | number | Date) {
      if (value === undefined) {
        super(2026, 10, 23, 2, 0, 0);
      } else if (value instanceof RealDate) {
        super(value.getTime());
      } else {
        super(value);
      }
    }

    static override now() {
      return new RealDate(2026, 10, 23, 2, 0, 0).getTime();
    }
  }

  (globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
  try {
    assert.equal(todayStr(), "2026-11-23");
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
});

test("fmtDate formats date-only and Date values consistently", () => {
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate("2026-11-23"), "23 Nov 2026");
  assert.equal(fmtDate(new Date(2026, 10, 23)), "23 Nov 2026");
});

test("default scale grades every percentage from 0 to 100", async () => {
  const { DEFAULT_SCALE } = await import("../src/lib/grading");
  for (let pct = 0; pct <= 100; pct += 0.5) {
    const g = gradeFor(pct, DEFAULT_SCALE);
    assert.equal(g.fail, pct < 40, `pct ${pct}`);
  }
  assert.equal(gradeFor(100, DEFAULT_SCALE).grade, "A+");
  assert.equal(gradeFor(39.9, DEFAULT_SCALE).grade, "F");
});

test("settingKey keeps school 1 keys and scopes other tenants", async () => {
  const { settingKey } = await import("../src/lib/grading");
  assert.equal(settingKey(1, "school_name"), "school_name");
  assert.equal(settingKey(7, "school_name"), "s7:school_name");
});
