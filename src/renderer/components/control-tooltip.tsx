import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Compose on the existing control: no extra button or tab stop. */
export function ControlTooltip({
  label,
  enabled = true,
  delay,
  side,
  children,
}: {
  label?: string | undefined;
  enabled?: boolean;
  delay?: number;
  /** Where it opens; above by default. A collapsed sidebar's open beside it, the sidebar toggle's below it. */
  side?: "top" | "right" | "bottom";
  children: ReactElement;
}) {
  return (
    <Tooltip disabled={!enabled || !label}>
      <TooltipTrigger render={children} delay={delay} />
      <TooltipContent className="[overflow-wrap:anywhere]" {...(side ? { side } : {})}>{label}</TooltipContent>
    </Tooltip>
  );
}
