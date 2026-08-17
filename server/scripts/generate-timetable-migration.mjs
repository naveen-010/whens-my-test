const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);

const mainLine = /^\s*\d+(?:\.\d+)?\s+([A-Z]{2,5}\s+[A-Z]\d{3}(?:-\d|[A-Z])?)\s+(.+?)\s+(-|\d+)\s+(-|\d+)\s+(\d+)\s+([LTP]\d+[A-Z]*)\s/;
const courses = new Map();
let currentCourse = null;

function addSection(courseCode, sectionCode) {
  const course = courses.get(courseCode);
  if (!course || !/^[LTP]\d+[A-Z]*$/.test(sectionCode)) return;
  course.sections.add(sectionCode);
}

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const main = line.match(mainLine);
  if (main) {
    const [, code, rawTitle, , , , section] = main;
    const nearbyTitle = [lines[index - 1], lines[index + 1]]
      .filter(Boolean)
      .map((nearbyLine) => nearbyLine.slice(25, 68).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    const title = rawTitle.replace(/\s+/g, " ").trim() || nearbyTitle;
    if (title.length < 2) throw new Error(`Missing title for ${code}`);
    if (!courses.has(code)) courses.set(code, { title, sections: new Set() });
    currentCourse = code;
    addSection(code, section);
    continue;
  }

  if (!currentCourse) continue;
  const candidates = [...line.matchAll(/\s{2,}([LTP]\d+[A-Z]*)\s{2,}/g)];
  if (candidates.length) addSection(currentCourse, candidates[0][1]);
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const palette = ["#2f6f68", "#2f5d8a", "#9a5b36", "#6b4f8a", "#4d6b42", "#89536a"];
function colorFor(code) {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

const sortedCourses = [...courses.entries()].sort(([a], [b]) => a.localeCompare(b));
const sectionRows = sortedCourses.flatMap(([courseCode, course]) =>
  [...course.sections]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((sectionCode) => [
      courseCode,
      sectionCode.startsWith("L") ? "lecture" : sectionCode.startsWith("T") ? "tutorial" : "practical",
      sectionCode,
    ])
);

if (sortedCourses.length < 500 || sectionRows.length < 1200) {
  throw new Error(`Timetable parse looks incomplete: ${sortedCourses.length} courses, ${sectionRows.length} sections`);
}

console.log("-- Generated from the official Pilani timetable, First Semester 2026-2027.");
console.log("ALTER TABLE sections DROP CONSTRAINT IF EXISTS sections_code_check;");
console.log("ALTER TABLE sections ADD CONSTRAINT sections_code_check CHECK (code ~ '^[LTP][0-9]+[A-Z]*$');\n");
console.log("INSERT INTO courses (code, name, color) VALUES");
console.log(sortedCourses.map(([code, course]) => `  (${quote(code)}, ${quote(course.title)}, ${quote(colorFor(code))})`).join(",\n"));
console.log("ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;\n");

console.log("INSERT INTO course_offerings (course_id, campus, academic_year, semester)");
console.log("SELECT id, 'Pilani', '2026-2027', 1 FROM courses");
console.log(`WHERE code IN (${sortedCourses.map(([code]) => quote(code)).join(", ")})`);
console.log("ON CONFLICT (course_id, campus, academic_year, semester) DO NOTHING;\n");

console.log("INSERT INTO sections (offering_id, section_type, code)");
console.log("SELECT o.id, imported.section_type, imported.section_code");
console.log("FROM (VALUES");
console.log(sectionRows.map((row) => `  (${row.map(quote).join(", ")})`).join(",\n"));
console.log(") AS imported(course_code, section_type, section_code)");
console.log("JOIN courses c ON c.code = imported.course_code");
console.log("JOIN course_offerings o ON o.course_id = c.id");
console.log("  AND o.campus = 'Pilani' AND o.academic_year = '2026-2027' AND o.semester = 1");
console.log("ON CONFLICT (offering_id, code) DO NOTHING;");
