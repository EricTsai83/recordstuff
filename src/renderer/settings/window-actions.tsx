/** Hide is one click; quitting takes the arrow menu, in the sidebar and the narrow About footer. */
import { ChevronDown, PanelBottomClose, Power } from "lucide-react";
import type { SettingsGroup, SettingsChoice } from "../../shared/settings-panel";
import { Button } from "../components/ui/button";
import { ControlTooltip } from "../components/control-tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";
import * as model from "./settings-controller";

export function WindowActions({ group, quit, id = "setting-about-hide", sidebar = false }: {
  group: SettingsGroup;
  quit: SettingsChoice;
  id?: string;
  sidebar?: boolean;
}) {
  const hide = group.choices.find(choice => choice.id === "hide"),
    busy = Boolean(model.saving),
    enabled = (choice: SettingsChoice | undefined): boolean => Boolean(choice && group.enabled && choice.enabled && !busy && !choice.busy);
  const choose = (choice: SettingsChoice): void => {
    if (enabled(choice)) void model.choose(group.id, choice.id, id);
  };
  return (
    <div role="group" aria-label={model.text("RecordStuff window actions")}
      className={`inline-flex h-9 max-w-full items-stretch rounded-lg border border-border/70 bg-background/80 ${sidebar ? "w-full" : ""}`}>
      <ControlTooltip label={hide?.label ?? model.text("Hide RecordStuff")}>
        <Button id={id} data-action="hide" variant="ghost" aria-label={model.text("Hide interface")}
          disabled={!group.enabled || !hide?.enabled} aria-disabled={!enabled(hide)}
          className="h-full flex-1 justify-start gap-2 rounded-none rounded-l-lg border-0 px-3 [&_svg]:text-muted-foreground"
          onClick={() => { if (hide) choose(hide); }}>
          <PanelBottomClose aria-hidden="true" />
          {model.text("Hide interface")}
        </Button>
      </ControlTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger id={`${id}-menu`} aria-label={model.text("More window actions")}
          disabled={!enabled(quit)}
          render={<Button variant="ghost" size="icon" className="h-full w-8 rounded-none rounded-r-lg border-0 border-l border-border/70 text-muted-foreground hover:text-foreground" />}>
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent id={`${id}-menu-content`} data-window-actions="" side="top" align="end" className="w-auto min-w-48">
          <DropdownMenuItem id={`${id}-quit-option`} disabled={!enabled(quit)} onClick={() => choose(quit)}>
            <Power aria-hidden="true" />{quit.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
