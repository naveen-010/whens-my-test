const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);

const courseLine = /^\s*(\d+(?:\.\d+)?)\s+([A-Z]{2,5}\s+[A-Z]\d{3}(?:-\d|[A-Z])?)\s+/;
const sectionCode = /^[LTP]\d+[A-Z]*$/;
const dayNames = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  Th: "Thursday",
  F: "Friday",
  S: "Saturday",
};
const schedules = new Map();
let currentCourse = null;
let currentComputerCode = null;

function expandDays(value) {
  const days = value.match(/Th|M|T|W|F|S/g) ?? [];
  return days.join("") === value ? days : [];
}

function expandHours(value) {
  if (value === "10") return [10];
  if (value.endsWith("10")) {
    return [...value.slice(0, -2)].map(Number).concat(10);
  }
  return [...value].map(Number);
}

function parseSchedule(value) {
  const tokens = value.trim().split(/\s+/);
  const entries = [];
  let index = 0;

  while (index < tokens.length) {
    const dayTokens = [];
    while (index < tokens.length && !/^\d+$/.test(tokens[index])) {
      dayTokens.push(tokens[index]);
      index += 1;
    }
    const hourTokens = [];
    while (index < tokens.length && /^\d+$/.test(tokens[index])) {
      hourTokens.push(tokens[index]);
      index += 1;
    }
    if (!dayTokens.length || !hourTokens.length) return [];

    const days = dayTokens.flatMap(expandDays);
    const hours = hourTokens.flatMap(expandHours);
    if (!days.length || hours.some((hour) => hour < 1 || hour > 10)) return [];
    for (const day of days) {
      for (const hour of hours) entries.push({ day: dayNames[day], hour });
    }
  }

  return entries;
}

for (const line of lines) {
  const course = line.match(courseLine);
  if (course) {
    currentComputerCode = Number(course[1]);
    currentCourse = course[2];
  }
  if (!currentCourse) continue;

  const columns = line.trim().split(/\s{2,}/);
  const sectionIndex = columns.findIndex((column) => sectionCode.test(column));
  if (sectionIndex < 0) continue;

  for (const column of columns.slice(sectionIndex + 1)) {
    const schedule = parseSchedule(column);
    if (!schedule.length) continue;
    const key = `${currentCourse}\t${columns[sectionIndex]}`;
    const existing = schedules.get(key);
    if (existing && JSON.stringify(existing.schedule) !== JSON.stringify(schedule)) {
      const existingIsNewAdmissions = existing.computerCode >= 5000;
      const currentIsNewAdmissions = currentComputerCode >= 5000;
      if (existingIsNewAdmissions === currentIsNewAdmissions) {
        throw new Error(`Conflicting schedule rows for ${key}`);
      }
      if (!existingIsNewAdmissions) break;
    }
    schedules.set(key, { schedule, computerCode: currentComputerCode });
    break;
  }
}

if (schedules.size < 1200) {
  throw new Error(`Timetable schedule parse looks incomplete: ${schedules.size} rows`);
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const knownSchedule = schedules.get("PHY F211\tT1")?.schedule;
if (JSON.stringify(knownSchedule) !== JSON.stringify([{ day: "Monday", hour: 9 }])) {
  throw new Error("Known PHY F211 T1 schedule did not parse correctly");
}

const rows = [...schedules.entries()]
  .map(([key, value]) => {
    const [course, section] = key.split("\t");
    return [course, section, JSON.stringify(value.schedule)];
  })
  .sort(([courseA, sectionA], [courseB, sectionB]) =>
    courseA.localeCompare(courseB) || sectionA.localeCompare(sectionB, undefined, { numeric: true })
  );

console.error(`Parsed ${rows.length} section schedules`);
console.log("-- Generated from the official Pilani timetable, First Semester 2026-2027.");
console.log("UPDATE sections AS section");
console.log("SET schedule = imported.schedule::jsonb");
console.log("FROM (VALUES");
console.log(rows.map((row) => `  (${row.map(quote).join(", ")})`).join(",\n"));
console.log(") AS imported(course_code, section_code, schedule)");
console.log("JOIN courses course ON course.code = imported.course_code");
console.log("JOIN course_offerings offering ON offering.course_id = course.id");
console.log("  AND offering.campus = 'Pilani'");
console.log("  AND offering.academic_year = '2026-2027'");
console.log("  AND offering.semester = 1");
console.log("WHERE section.offering_id = offering.id");
console.log("  AND section.code = imported.section_code;");
