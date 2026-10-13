/** The Keyboard Shortcuts tab's rows (plan 073): read-only, from main's projection of `shortcut-catalog.ts`. */
import { ArrowUpRight } from "lucide-react";
import { Fragment } from "react";
import type { SettingsGroup, ShortcutRowView } from "../../../shared/settings-panel";
import { ControlTooltip } from "../../components/control-tooltip";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Kbd, KbdGroup } from "../../components/ui/kbd";
import * as model from "../settings-controller";

function ShortcutRow({ row }: { row: ShortcutRowView }) {
  const id = `shortcut-${row.id}`,
    or = model.text("or");
  return (
    <div id={`${id}-row`} className="row block gap-0" data-status={row.status?.kind}>
      <div className="row-line">
        <div className="group-title">
          <span id={`${id}-label`} className="group-label text-xs leading-[1.35]">{row.label}</span>
          {row.status && (
            <Badge id={`${id}-status`} size="md" variant={row.status.kind === "unavailable" ? "destructive" : "secondary"}>
              {row.status.label}
            </Badge>
          )}
          {/* An arrow beside the label, so every row's keys stay alike: it goes to the Shortcut card, which edits them. */}
          {row.change && (
            <ControlTooltip label={row.change}>
              <Button
                id={`${id}-change`}
                variant="ghost"
                size="icon"
                className="text-muted-foreground"
                aria-label={row.change}
                aria-describedby={`${id}-label`}
                onClick={() => model.showShortcutCard()}
              >
                <ArrowUpRight aria-hidden="true" />
              </Button>
            </ControlTooltip>
          )}
        </div>
        <div className="controls">
          {/* Symbols alone read poorly aloud: the keys are drawn for sight and said once as a phrase. */}
          <span id={`${id}-keys`} className="sr-only">
            {[...row.spoken, ...(row.gesture ? [row.gesture] : [])].join(` ${or} `)}
          </span>
          {row.keys.map((keys, index) => (
            <Fragment key={row.spoken[index]}>
              {index > 0 && <span className="text-xs text-muted-foreground" aria-hidden="true">{or}</span>}
              <KbdGroup aria-hidden="true">
                {keys.map((key, at) => <Kbd key={at} size="md">{key}</Kbd>)}
              </KbdGroup>
            </Fragment>
          ))}
          {row.gesture && (
            <>
              <span className="text-xs text-muted-foreground" aria-hidden="true">{or}</span>
              <span className="text-xs" aria-hidden="true">{row.gesture}</span>
            </>
          )}
        </div>
      </div>
      {row.where && <p id={`${id}-where`} className="note">{row.where}</p>}
      {row.status?.reason && <p id={`${id}-reason`} className="note">{row.status.reason}</p>}
    </div>
  );
}

export function ShortcutRows({ group }: { group: SettingsGroup }) {
  return (group.shortcuts ?? []).map((row) => <ShortcutRow key={row.id} row={row} />);
}
