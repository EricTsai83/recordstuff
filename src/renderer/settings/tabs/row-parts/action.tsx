/**
 * A row's action button: a request to main whose outcome the row then shows.
 */
import type { SettingsGroup, SettingsChoice } from "../../../../shared/settings-panel";
import { Button } from "../../../components/ui/button";
import { ControlTooltip } from "../../../components/control-tooltip";
import * as model from "../../settings-controller";
import { ActionIcon, GroupIcon } from "./icons";

export function Action({
  group,
  choice,
  id = `setting-${group.id}-${choice.id}`,
  wrap,
  className,
}: {
  group: SettingsGroup;
  choice: SettingsChoice;
  id?: string;
  /** A row's button wraps its label rather than run past the card, which would hide its end (plan 067). */
  wrap?: boolean;
  className?: string | undefined;
}) {
  const busy = Boolean(model.savingOf(group.id)) || choice.busy === true,
    iconOnly = group.id === "about" && (choice.id === "website" || choice.id === "source");
  return (
    <ControlTooltip label={iconOnly ? choice.label : undefined}>
      <Button
        id={id}
        data-action={choice.id}
        variant={group.id === "log" ? "link" : group.id === "localData" ? "destructive" : group.id === "about" || choice.id === "quit" ? "ghost" : "outline"}
        size={iconOnly ? "icon" : "default"}
        wrap={iconOnly ? false : wrap}
        className={group.id === "log" ? `h-auto min-h-6 justify-start gap-2 rounded-none px-0 ${className ?? ""}` : iconOnly ? `px-0 ${className ?? ""}` : className}
        disabled={!group.enabled || !choice.enabled}
        aria-disabled={busy || !group.enabled || !choice.enabled}
        aria-label={group.id === "about" ? choice.label : undefined}
        aria-describedby={group.id === "localData" ? "setting-localData-note settings-data-cleanup-warning" : undefined}
        onClick={() => {
          if (!busy && group.enabled && choice.enabled)
            void model.choose(group.id, choice.id, id);
        }}
      >
        {group.id === "log" && <GroupIcon id={group.id} />}
        {group.id === "about" && <ActionIcon id={choice.id} />}
        {!iconOnly && (group.id === "log" ? group.label : choice.label)}
      </Button>
    </ControlTooltip>
  );
}
