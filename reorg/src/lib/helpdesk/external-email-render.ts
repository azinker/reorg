export interface ExternalEmailRenderOptions {
  appName?: string;
  footerText?: string;
}

const SIMPLE_EMAIL_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;

export function formatHelpdeskFromAddress(
  fromAddress: string,
  displayName = "The Perfect Part Help Desk",
): string {
  const trimmed = fromAddress.trim();
  if (!trimmed) return trimmed;
  if (/<[^<>]+>/.test(trimmed)) return trimmed;
  if (!SIMPLE_EMAIL_PATTERN.test(trimmed)) return trimmed;
  return `${quoteMailboxDisplayName(displayName)} <${trimmed}>`;
}

export function renderExternalEmailHtml(
  bodyText: string,
  options: ExternalEmailRenderOptions = {},
): string {
  const appName = options.appName ?? "The Perfect Part";
  const footerText =
    options.footerText ??
    `You received this message because ${appName} contacted you about an existing support conversation. Reply directly to this email to continue the thread.`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(appName)}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background:#ffffff;color:#111827;font-family:Arial,Helvetica,sans-serif;">',
    '<div style="max-width:680px;margin:0 auto;padding:24px 20px;">',
    `<div style="font-size:14px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(bodyText)}</div>`,
    '<div style="margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px;font-size:12px;line-height:1.45;color:#6b7280;">',
    escapeHtml(footerText),
    "</div>",
    "</div>",
    "</body>",
    "</html>",
  ].join("");
}

function quoteMailboxDisplayName(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/["\\]/g, "\\$&")}"`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
