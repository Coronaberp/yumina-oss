import { WandSparkles } from "lucide-react";

export function NameGenerationCard({ names, failed }: { names: string[]; failed: boolean }) {
  return (
    <section className="min-w-0 rounded-lg border border-border/60 bg-muted/30 p-2.5 text-xs" aria-label="Name generation results">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <WandSparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        <span>{failed ? "Name generation failed" : "Generated names"}</span>
        {!failed && <span className="text-muted-foreground">({names.length})</span>}
      </div>
      {names.length > 0 ? (
        <ol className="mt-2 max-h-48 list-decimal space-y-1 overflow-y-auto overscroll-contain pl-6 pr-1">
          {names.map((name, index) => <li key={`${index}-${name}`} className="break-words text-foreground">{name}</li>)}
        </ol>
      ) : (
        <p className="mt-1 text-muted-foreground">{failed ? "No names were returned." : "No names were generated."}</p>
      )}
    </section>
  );
}
