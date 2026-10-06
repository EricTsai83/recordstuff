import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Compose on the existing control: no extra button or tab stop. */
export function ControlTooltip({
  label,
  enabled = true,
  children,
}: {
  label?: string | undefined;
  enabled?: boolean;
  children: ReactElement;
}) {
  return (
    <Tooltip disabled={!enabled || !label}>
      <TooltipTrigger render={children} />
      <TooltipContent className="[overflow-wrap:anywhere]">{label}</TooltipContent>
    </Tooltip>
  );
}
