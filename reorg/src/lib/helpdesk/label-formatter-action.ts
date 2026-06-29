export function resolveLabelFormatterActionNote(input: {
  inr: boolean;
  postageIssue: boolean;
}): string {
  if (input.postageIssue) return "COUNTERFEIT";
  if (input.inr) return "INR CASE";
  return "";
}

export function labelFormatterActionNoteSuffix(input: {
  inr: boolean;
  postageIssue: boolean;
}): string {
  const note = resolveLabelFormatterActionNote(input);
  return note ? ` + ${note}` : "";
}
