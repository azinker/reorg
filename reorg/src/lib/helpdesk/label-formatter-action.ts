export function resolveLabelFormatterActionNote(input: {
  inr: boolean;
  postageIssue: boolean;
  customNote?: string | null;
}): string {
  if (input.postageIssue) return "COUNTERFEIT";
  if (input.inr) return "INR CASE";
  const customNote = input.customNote?.trim();
  if (customNote) return customNote;
  return "";
}

export function labelFormatterActionNoteSuffix(input: {
  inr: boolean;
  postageIssue: boolean;
  customNote?: string | null;
}): string {
  const note = resolveLabelFormatterActionNote(input);
  return note ? ` + ${note}` : "";
}
