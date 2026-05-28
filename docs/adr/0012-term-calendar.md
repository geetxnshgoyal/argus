# ADR-0012: Term calendar for holidays and day-order swaps

**Context.** The spec models one-off changes only as per-entry overrides. Holidays would need a cancel override for every entry that day, and colleges often declare "Saturday follows Monday's timetable".

**Decision.** Add a per-term calendar: `term_calendar_days(term_id, date, kind [holiday|exam|no_classes|working], follows_weekday NULL, note)`. Materialization applies: calendar → weekly defaults (using `follows_weekday` if set) → per-date overrides (override wins).

**Consequences.** Acad Ops declares a holiday in one action; overrides still work on top. Added to the M2 schema.
