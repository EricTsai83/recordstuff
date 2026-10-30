/** The sidebar's foot: Hide is one click and quitting takes the more-actions menu. A collapsed sidebar, a narrow
    window's among them, keeps one button, whose menu holds both (2026-10-20). */
import { Ellipsis, EyeOff, Power } from "lucide-react";
import type { SettingsGroup, SettingsChoice } from "../../shared/settings-panel";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";
import { ControlTooltip } from "../components/control-tooltip";
import * as model from "./settings-controller";

export function WindowActions({ group, quit, id, compact = false }: {
  group: SettingsGroup;
  quit: SettingsChoice;
  id: string;
  /** A collapsed sidebar's: one icon, named by its tooltip, whose menu holds Hide and Quit. */
  compact?: boolean;
}) {
  const hide = group.choices.find(choice => choice.id === "hide"),
    // Hide and Quit wait for every save: leaving the window mid-save would end it unseen.
    busy = model.anySaving(),
    enabled = (choice: SettingsChoice | undefined): boolean => Boolean(choice && group.enabled && choice.enabled && !busy && !choice.busy);
  const choose = (choice: SettingsChoice): void => {
    if (enabled(choice)) void model.choose(group.id, choice.id, id);
  };
  if (compact) return (
    <div role="group" aria-label={model.text("RecordStuff window actions")} className="inline-flex text-muted-foreground">
      <DropdownMenu>
        <ControlTooltip label={model.text("RecordStuff window actions")} side="right">
          <DropdownMenuTrigger id={`${id}-menu`} aria-label={model.text("RecordStuff window actions")}
            disabled={!enabled(hide) && !enabled(quit)}
            render={<Button variant="ghost" size="icon" className="darwin:window-no-drag size-9 short:size-8 rounded-lg border-0 hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent" />}>
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
        </ControlTooltip>
        <DropdownMenuContent id={`${id}-menu-content`} data-window-actions="" side="right" sideOffset={10} align="end"
          className="w-48 min-w-0 rounded-lg p-1.5">
          <DropdownMenuItem id={id} data-action="hide" className="min-h-8 gap-2 px-2.5" disabled={!enabled(hide)} onClick={() => { if (hide) choose(hide); }}>
            <EyeOff aria-hidden="true" className="text-muted-foreground" />{model.text("Hide interface")}
          </DropdownMenuItem>
          <DropdownMenuItem id={`${id}-quit-option`} className="min-h-8 gap-2 px-2.5" disabled={!enabled(quit)} onClick={() => choose(quit)}>
            <Power aria-hidden="true" className="text-muted-foreground" />{quit.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  return (
    <div role="group" aria-label={model.text("RecordStuff window actions")}
      className="inline-flex min-h-9 w-full max-w-full items-stretch gap-1 text-muted-foreground">
      <Button id={id} data-action="hide" variant="ghost" aria-label={model.text("Hide interface")}
        disabled={!group.enabled || !hide?.enabled} aria-disabled={!enabled(hide)}
        className="darwin:window-no-drag h-auto min-h-[34px] min-w-0 flex-1 justify-start gap-2 rounded-lg border-0 hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent px-3 py-1.5 text-left whitespace-normal"
        onClick={() => { if (hide) choose(hide); }}>
        <EyeOff aria-hidden="true" />
        {model.text("Hide interface")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger id={`${id}-menu`} aria-label={model.text("More window actions")}
          disabled={!enabled(quit)}
          render={<Button variant="ghost" size="icon" className="darwin:window-no-drag relative h-auto min-h-[34px] w-9 rounded-lg border-0 hover:bg-sidebar-accent aria-expanded:bg-sidebar-accent" />}>
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent id={`${id}-menu-content`} data-window-actions="" side="top" sideOffset={8} align="end"
          className="w-(--settings-sidebar-width) min-w-0 rounded-lg p-1.5">
          <DropdownMenuItem id={`${id}-quit-option`} className="min-h-8 gap-2 px-2.5" disabled={!enabled(quit)} onClick={() => choose(quit)}>
            <Power aria-hidden="true" className="text-muted-foreground" />{quit.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
