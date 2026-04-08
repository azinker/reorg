"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  AlertTriangle,
  Info,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CHANNEL_OPTIONS = [
  { value: "TPP_EBAY", label: "eBay TPP — The Perfect Part" },
  { value: "TT_EBAY", label: "eBay TT — Telitetech" },
] as const;

const TOKENS = [
  { key: "{buyer_name}", label: "Buyer Name", example: "John Smith" },
  { key: "{buyer_first_name}", label: "Buyer First Name", example: "John" },
  { key: "{order_id}", label: "Order ID", example: "13-14447-09753" },
  { key: "{item_name}", label: "Item Name", example: "High Speed Memory Card" },
  { key: "{tracking_number}", label: "Tracking Number", example: "9401903308745112568932" },
  { key: "{carrier}", label: "Carrier", example: "USPS" },
  { key: "{store_name}", label: "Store Name", example: "The Perfect Part" },
];

const SUBJECT_MAX = 200;
const BODY_MAX = 2000;

interface EditorProps {
  mode: "create" | "edit";
  responderId?: string;
}

type Step = "name" | "channel" | "template" | "review";
const STEPS: Step[] = ["name", "channel", "template", "review"];
const STEP_LABELS: Record<Step, string> = {
  name: "Message Name",
  channel: "Channel",
  template: "Subject & Body",
  review: "Review",
};

export function AutoResponderEditor({ mode, responderId }: EditorProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [messageName, setMessageName] = useState("");
  const [channel, setChannel] = useState<string>("TPP_EBAY");
  const [subjectTemplate, setSubjectTemplate] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const loadResponder = useCallback(async () => {
    if (mode !== "edit" || !responderId) return;
    try {
      const res = await fetch(`/api/auto-responder/${responderId}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load");
      const d = json.data;
      setMessageName(d.messageName);
      setChannel(d.channel);
      setSubjectTemplate(d.subjectTemplate);
      setBodyTemplate(d.bodyTemplate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [mode, responderId]);

  useEffect(() => { loadResponder(); }, [loadResponder]);

  function insertToken(token: string, field: "subject" | "body") {
    if (field === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const start = el.selectionStart ?? el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(el.selectionEnd ?? start);
      setSubjectTemplate(before + token + after);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    } else if (field === "body" && bodyRef.current) {
      const el = bodyRef.current;
      const start = el.selectionStart ?? el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(el.selectionEnd ?? start);
      setBodyTemplate(before + token + after);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    }
  }

  function canProceed(): boolean {
    switch (step) {
      case "name": return messageName.trim().length > 0;
      case "channel": return !!channel;
      case "template": return subjectTemplate.trim().length > 0 && bodyTemplate.trim().length > 0;
      case "review": return true;
      default: return false;
    }
  }

  function nextStep() {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  }

  function prevStep() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  }

  async function handleSave(activate: boolean) {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const body = { messageName: messageName.trim(), channel, subjectTemplate, bodyTemplate };

      if (mode === "create") {
        const res = await fetch("/api/auto-responder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));

        if (activate) {
          const actRes = await fetch(`/api/auto-responder/${json.data.id}/activate`, { method: "POST" });
          const actJson = await actRes.json();
          if (!actRes.ok) throw new Error(actJson.error ?? "Activation failed");
        }

        setSuccess("Responder created!");
        setTimeout(() => router.push("/auto-responder"), 1000);
      } else {
        const res = await fetch(`/api/auto-responder/${responderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));

        setSuccess("Responder updated!");
        setTimeout(() => router.push("/auto-responder"), 1000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Simple preview rendering
  function renderPreview(template: string): string {
    const subs: Record<string, string> = {};
    for (const t of TOKENS) subs[t.key] = t.example;
    return template.replace(/\{[a-z_]+\}/g, (m) => subs[m] ?? m);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-5 w-5 animate-spin text-white/30" />
      </div>
    );
  }

  const currentIdx = STEPS.indexOf(step);

  return (
    <div className="flex flex-col gap-6 px-6 py-6 max-w-3xl mx-auto w-full">
      <Link href="/auto-responder" className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 transition-colors w-fit cursor-pointer">
        <ArrowLeft className="h-4 w-4" />
        Back to Responders
      </Link>

      <h1 className="text-xl font-semibold text-white">
        {mode === "create" ? "New Responder" : "Edit Responder"}
      </h1>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <button
              onClick={() => { if (i <= currentIdx) setStep(s); }}
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded transition-colors",
                step === s ? "bg-white/15 text-white" : i < currentIdx ? "bg-white/5 text-white/60 cursor-pointer hover:text-white/80" : "bg-white/5 text-white/30",
                i <= currentIdx && "cursor-pointer",
              )}
            >
              <span className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-white/10">
                {i < currentIdx ? <Check className="h-3 w-3 text-emerald-400" /> : i + 1}
              </span>
              {STEP_LABELS[s]}
            </button>
            {i < STEPS.length - 1 && <ChevronDown className="h-3 w-3 text-white/20 -rotate-90" />}
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <Check className="h-4 w-4 shrink-0" />
          {success}
        </div>
      )}

      {/* Step Content */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-6">
        {step === "name" && (
          <div className="space-y-4">
            <label className="block text-sm text-white/60">
              Message Name
              <span className="text-white/30 text-xs ml-1">(internal label only — buyers won&apos;t see this)</span>
            </label>
            <input
              type="text"
              value={messageName}
              onChange={(e) => setMessageName(e.target.value)}
              placeholder="e.g. Shipping Confirmation v1"
              autoFocus
              className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20"
              maxLength={100}
            />
            <p className="text-xs text-white/30">{messageName.length}/100 characters</p>
          </div>
        )}

        {step === "channel" && (
          <div className="space-y-4">
            <label className="block text-sm text-white/60">Channel</label>
            <p className="text-xs text-white/30 -mt-2">
              Select which eBay store this responder will send messages from. Only one active responder per channel.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CHANNEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setChannel(opt.value)}
                  className={cn(
                    "flex flex-col items-start rounded-lg border p-4 transition-colors cursor-pointer text-left",
                    channel === opt.value
                      ? "border-white/30 bg-white/10 text-white"
                      : "border-white/10 bg-white/5 text-white/50 hover:border-white/20 hover:text-white/70",
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "template" && (
          <div className="space-y-6">
            {/* Token palette */}
            <div className="rounded border border-white/10 bg-black/20 p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Info className="h-3 w-3 text-white/40" />
                <span className="text-xs text-white/50 font-medium">Available Tokens</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {TOKENS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => insertToken(t.key, "body")}
                    className="rounded bg-white/5 border border-white/10 px-2 py-1 text-xs text-white/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer font-mono"
                    title={`${t.label} — e.g. ${t.example}`}
                  >
                    {t.key}
                  </button>
                ))}
              </div>
            </div>

            {/* Subject */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-sm text-white/60">Subject</label>
                <span className={cn("text-xs tabular-nums", subjectTemplate.length > SUBJECT_MAX ? "text-red-400" : "text-white/30")}>
                  {subjectTemplate.length}/{SUBJECT_MAX}
                </span>
              </div>
              <input
                ref={subjectRef}
                type="text"
                value={subjectTemplate}
                onChange={(e) => setSubjectTemplate(e.target.value)}
                placeholder="e.g. Your order {order_id} has shipped!"
                className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20"
              />
              {subjectTemplate && (
                <div className="rounded bg-black/20 px-3 py-2">
                  <span className="text-[10px] text-white/30 uppercase tracking-wider">Preview: </span>
                  <span className="text-xs text-white/60">{renderPreview(subjectTemplate)}</span>
                </div>
              )}
            </div>

            {/* Body */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-sm text-white/60">Body</label>
                <span className={cn("text-xs tabular-nums", bodyTemplate.length > BODY_MAX ? "text-red-400" : "text-white/30")}>
                  {bodyTemplate.length}/{BODY_MAX}
                </span>
              </div>
              <textarea
                ref={bodyRef}
                value={bodyTemplate}
                onChange={(e) => setBodyTemplate(e.target.value)}
                placeholder={"Hi {buyer_first_name},\n\nYour order {order_id} for {item_name} has shipped.\n\nTracking number: {tracking_number}\nCarrier: {carrier}\n\nThank you for shopping with {store_name}!"}
                rows={8}
                className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20 resize-y font-mono"
              />
              {bodyTemplate && (
                <div className="rounded bg-black/20 px-3 py-3">
                  <span className="text-[10px] text-white/30 uppercase tracking-wider block mb-1">Preview</span>
                  <pre className="text-xs text-white/60 whitespace-pre-wrap font-sans leading-relaxed">
                    {renderPreview(bodyTemplate)}
                  </pre>
                </div>
              )}
            </div>

            <p className="text-xs text-white/30 flex items-start gap-1.5">
              <Info className="h-3 w-3 shrink-0 mt-0.5" />
              eBay messages do not support HTML formatting. Plain text only.
            </p>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-white/70">Review your responder</h3>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-white/30 text-xs">Name</span>
                <p className="text-white/80">{messageName}</p>
              </div>
              <div>
                <span className="text-white/30 text-xs">Channel</span>
                <p className="text-white/80">{CHANNEL_OPTIONS.find((c) => c.value === channel)?.label ?? channel}</p>
              </div>
            </div>

            <div className="rounded border border-white/10 bg-black/20 p-4 space-y-3">
              <div>
                <span className="text-xs text-white/30">Subject</span>
                <p className="text-sm text-white/80 font-medium mt-0.5">{renderPreview(subjectTemplate)}</p>
              </div>
              <div>
                <span className="text-xs text-white/30">Body</span>
                <pre className="text-sm text-white/70 whitespace-pre-wrap font-sans leading-relaxed mt-0.5">
                  {renderPreview(bodyTemplate)}
                </pre>
              </div>
            </div>

            <p className="text-xs text-white/30">
              Saving will create the responder in <strong>Inactive</strong> status.
              You can activate it separately, or click Save & Activate to go live immediately.
            </p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={prevStep}
          disabled={currentIdx === 0}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-white/5 text-white/50 hover:text-white/80 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <div className="flex items-center gap-2">
          {step === "review" ? (
            <>
              <button
                onClick={() => handleSave(false)}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer disabled:opacity-40"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {mode === "create" ? "Save" : "Update"}
              </button>
              {mode === "create" && (
                <button
                  onClick={() => handleSave(true)}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save & Activate
                </button>
              )}
            </>
          ) : (
            <button
              onClick={nextStep}
              disabled={!canProceed()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
