# BITS Test Calendar

A local-first frontend prototype for a section-aware test calendar for BITS Pilani students.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Included in this prototype

- Compact weekly calendar with detailed hover, focus, and tap cards
- Month, year, and agenda views
- Own-section and other-section test signals
- Official, reported, confirmed, and disputed states
- Student confirmation interaction
- Course following
- Add-test form with source and syllabus information
- Reminder and Google Calendar prototype settings
- Light and dark themes
- Responsive layouts

All data is currently held in browser state and resets when the page reloads. Google Calendar and BITS email authentication are represented as prototype interactions only. A backend, persistent database, and OAuth integration are required before real use.

## Checks

```bash
npm run build
npm run lint
```
