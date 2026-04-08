"use client";

import { use } from "react";
import { AutoResponderEditor } from "@/components/auto-responder/responder-editor";

export default function EditAutoResponderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AutoResponderEditor mode="edit" responderId={id} />;
}
