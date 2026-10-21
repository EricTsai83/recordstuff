/**
 * A row's explanation: the ⓘ beside its title, opening a popover that says what the setting does.
 */
import { CircleHelp } from "lucide-react";
import type { SettingsGroup } from "../../../../shared/settings-panel";
import { translate } from "../../../../shared/i18n";
import { Button } from "../../../components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "../../../components/ui/popover";
import * as model from "../../settings-controller";

export function Explanation({ group }: { group: SettingsGroup }) {
  const id = `setting-${group.id}`,
    open = model.infoOpen?.id === group.id;
  return (
    <>
      <span id={`${id}-info`} hidden={!group.info} className="sr-only">
        {group.info}
      </span>
      <Popover
        open={open && Boolean(group.info)}
        onOpenChange={(value) => {
          if (value) model.showInfo(group.id, true);
          else if (open && !model.infoOpen?.pinned) model.hideInfo();
        }}
      >
        <PopoverTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          id={`${id}-info-button`}
          hidden={!group.info}
          aria-label={translate("More about {label}", model.view?.language, {
            label: group.label,
          })}
          aria-describedby={group.info ? `${id}-info` : undefined}
          aria-expanded={open}
          onMouseEnter={() => model.showInfo(group.id, false)}
          onMouseLeave={() => model.leaveInfo(group.id)}
          onFocus={() => model.showInfo(group.id, false)}
          onBlur={() => {
            if (open) model.hideInfo();
          }}
          onClick={(event) => {
            event.preventBaseUIHandler();
            event.preventDefault();
            if (open && model.infoOpen?.pinned) model.hideInfo();
            else model.showInfo(group.id, true);
          }}
        >
          <CircleHelp className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          id={`${id}-info-popup`}
          className="info-popup"
          side="top"
          initialFocus={false}
          finalFocus={false}
          onMouseEnter={() => model.showInfo(group.id, false)}
          onMouseLeave={() => model.leaveInfo(group.id)}
        >
          {group.info}
        </PopoverContent>
      </Popover>
    </>
  );
}
