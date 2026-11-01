/**
 * How far something is, as a ring with its percentage inside (2026-11-01, at the maintainer's request, for a refused
 * drag's promise toast). Base UI's Progress, as shadcn's bar is, so assistive technology reads it as a progress bar;
 * shadcn has no ring, so the picture is the app's own, on the same tokens.
 */
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";

const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ProgressRing({ value, label, className }: { value: number; label: string; className?: string }) {
  const fraction = Math.min(1, Math.max(0, value / 100));
  return (
    <ProgressPrimitive.Root value={value} aria-label={label} data-slot="progress-ring" className={cn("relative size-9 shrink-0", className)}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={RADIUS} fill="none" strokeWidth="3" className="stroke-muted-foreground/25" />
        <circle
          cx="18"
          cy="18"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          className="stroke-primary transition-[stroke-dashoffset] duration-240 ease-linear motion-reduce:transition-none"
        />
      </svg>
      <ProgressPrimitive.Value className="absolute inset-0 grid place-items-center text-[0.625rem] font-medium tabular-nums" />
    </ProgressPrimitive.Root>
  );
}
