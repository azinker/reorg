export interface ExternalEmailDraftInput {
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
}

export interface ExternalEmailDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
}

export type ExternalEmailDraftResult =
  | { ok: true; draft: ExternalEmailDraft }
  | { ok: false; error: string };

const EMAIL_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;

export function parseExternalEmailList(input: string | null | undefined): {
  emails: string[];
  invalid: string[];
} {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  const parts = String(input ?? "")
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const normalized = normalizeExternalEmailAddress(part);
    if (!normalized) {
      invalid.push(part);
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(normalized);
  }

  return { emails, invalid };
}

export function normalizeExternalEmailDraft(
  input: ExternalEmailDraftInput,
): ExternalEmailDraftResult {
  const to = parseExternalEmailList(input.to);
  const cc = parseExternalEmailList(input.cc);
  const bcc = parseExternalEmailList(input.bcc);
  const invalid = [
    ...to.invalid,
    ...cc.invalid,
    ...bcc.invalid,
  ];
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid email address: ${invalid.slice(0, 3).join(", ")}`,
    };
  }
  if (to.emails.length === 0) {
    return {
      ok: false,
      error: "Add at least one To recipient before sending an external email.",
    };
  }

  const subject = input.subject?.trim() || null;
  return {
    ok: true,
    draft: {
      to: to.emails,
      cc: cc.emails,
      bcc: bcc.emails,
      subject,
    },
  };
}

export function readExternalEmailDraftFromMetadata(
  metadata: unknown,
): ExternalEmailDraft | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).externalEmail;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const to = readStringArray(row.to);
  if (to.length === 0) return null;
  return {
    to,
    cc: readStringArray(row.cc),
    bcc: readStringArray(row.bcc),
    subject: typeof row.subject === "string" && row.subject.trim()
      ? row.subject.trim()
      : null,
  };
}

function normalizeExternalEmailAddress(value: string): string | null {
  let email = value.trim().replace(/^mailto:/i, "");
  const angleMatch = email.match(/<([^<>]+)>$/);
  if (angleMatch?.[1]) {
    email = angleMatch[1].trim();
  }
  email = email.replace(/^['"]+|['"]+$/g, "").trim();
  return EMAIL_PATTERN.test(email) ? email : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
