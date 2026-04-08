"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, Loader2, AlertTriangle, Search } from "lucide-react";

const CHANNEL_LABELS: Record<string, string> = {
  TPP_EBAY: "eBay TPP",
  TT_EBAY: "eBay TT",
};

export default function PreviewAutoResponderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [orderNumber, setOrderNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    renderedSubject: string;
    renderedBody: string;
    context: Record<string, string | null | undefined>;
    responderName: string;
    channel: string;
  } | null>(null);

  async function handlePreview() {
    if (!orderNumber.trim()) return;
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const res = await fetch(`/api/auto-responder/${id}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber: orderNumber.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Preview failed");
      setPreview(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 px-6 py-6 max-w-3xl mx-auto w-full">
      <Link href="/auto-responder" className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 transition-colors w-fit cursor-pointer">
        <ArrowLeft className="h-4 w-4" />
        Back to Responders
      </Link>

      <div className="flex items-center gap-3">
        <Eye className="h-5 w-5 text-white/60" />
        <h1 className="text-xl font-semibold text-white">Preview Message</h1>
      </div>

      <p className="text-sm text-white/50">
        Enter a real eBay order number to preview how the message will be rendered.
        This does not send a message.
      </p>

      <div className="flex items-end gap-3">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-white/50">Order Number</label>
          <input
            type="text"
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handlePreview()}
            placeholder="e.g. 13-14447-09753"
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20"
          />
        </div>
        <button
          onClick={handlePreview}
          disabled={loading || !orderNumber.trim()}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Preview
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-white/40">
            <span>{preview.responderName}</span>
            <span>&middot;</span>
            <span>{CHANNEL_LABELS[preview.channel] ?? preview.channel}</span>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
            <div className="border-b border-white/10 px-4 py-3">
              <div className="text-xs text-white/40 mb-1">Subject</div>
              <div className="text-sm text-white font-medium">{preview.renderedSubject}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-white/40 mb-1">Body</div>
              <pre className="text-sm text-white/80 whitespace-pre-wrap font-sans leading-relaxed">
                {preview.renderedBody}
              </pre>
            </div>
          </div>

          <details className="text-xs">
            <summary className="text-white/30 cursor-pointer hover:text-white/50">Token Values</summary>
            <div className="mt-2 rounded border border-white/10 bg-black/30 p-3 space-y-1">
              {Object.entries(preview.context).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <span className="text-white/30 w-32 shrink-0">{key}:</span>
                  <span className="text-white/60">{value ?? "—"}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
