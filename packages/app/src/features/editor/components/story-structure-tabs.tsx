import { useState } from "react";
import { RoutesSection } from "../sections/routes";
import { EndingsSection } from "../sections/endings";
export function StoryStructureTabs() {
  const [tab, setTab] = useState<"routes" | "endings">("routes");
  return <section className="space-y-5"><div className="flex gap-2" role="tablist"><button type="button" role="tab" aria-selected={tab === "routes"} onClick={() => setTab("routes")} className="rounded-xl border border-border px-4 py-2 text-sm">Routes</button><button type="button" role="tab" aria-selected={tab === "endings"} onClick={() => setTab("endings")} className="rounded-xl border border-border px-4 py-2 text-sm">Endings</button></div>{tab === "routes" ? <RoutesSection /> : <EndingsSection />}</section>;
}
