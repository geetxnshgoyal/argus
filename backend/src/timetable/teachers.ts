/**
 * Who teaches a class: the batch's assigned teacher for batch classes, otherwise
 * the section-wide assignment. Primary assignments win over assistants. A batch
 * class never falls back to another batch's teacher.
 */
export function resolveTeacher(
  assignments: { offering_id: string; group_id: string | null; teacher_id: string; role: string }[],
  offeringId: string,
  groupId: string | null,
): string | null {
  const forOffering = assignments.filter((a) => a.offering_id === offeringId);
  const pick = (g: string | null) => forOffering.find((a) => a.group_id === g && a.role === 'primary') ?? forOffering.find((a) => a.group_id === g);
  return (groupId ? pick(groupId) : undefined)?.teacher_id ?? pick(null)?.teacher_id ?? null;
}
