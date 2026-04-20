import { Suspense } from "react";
import HelpDeskClient from "./HelpDeskClient";

/**
 * Server-component shell for the Help Desk.
 *
 * `HelpDeskClient` uses `useSearchParams()`. In Next.js 15 (App Router) any
 * client component that reads the URL must be wrapped in a <Suspense> boundary
 * — otherwise Next opts the entire route into client-side rendering with no
 * streamable shell, which manifested as "the tab takes a moment to load when
 * I switch back to it." The Suspense fallback below is the exact same chrome
 * the client renders, just empty, so users see the layout immediately on
 * (re)mount instead of a blank page.
 */
export default function HelpDeskPage() {
  return (
    <Suspense fallback={<HelpDeskShellFallback />}>
      <HelpDeskClient />
    </Suspense>
  );
}

function HelpDeskShellFallback() {
  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col">
      <div className="h-12 border-b border-hairline bg-card" />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-56 border-r border-hairline bg-card" />
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading Help Desk…
        </div>
      </div>
    </div>
  );
}
