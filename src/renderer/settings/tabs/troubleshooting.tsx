/** Failure review and diagnostic actions have their own pages within Troubleshooting. */
import { useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import * as model from "../settings-controller";
import { Failures } from "./failures";
import { Preferences } from "./preferences";

export function Troubleshooting() {
  const entry = model.view?.resultFocus ?? 0;
  const [selection, setSelection] = useState({ page: "history", entry });
  // An explicit entry selects history before main restores focus to its row. Keep the tab buttons mounted so
  // restoring focus cannot reselect the previously focused tools tab during that handoff.
  const page = selection.entry === entry ? selection.page : "history";
  return (
    <Tabs.Root value={page} onValueChange={(value) => {
      if (value === "history" || value === "tools") setSelection({ page: value, entry });
    }} orientation="horizontal" className="flex min-w-0 flex-col gap-4">
      <Tabs.List activateOnFocus aria-label={model.text("Troubleshooting sections")} className="inline-flex w-fit max-w-full gap-1 rounded-lg bg-muted p-[3px]">
        {([["history", "Failure history"], ["tools", "Diagnostics and cleanup"]] as const).map(([value, label]) => (
          <Tabs.Tab
            key={value}
            value={value}
            id={`troubleshooting-${value}-tab`}
            className="focus-ring flex min-h-8 min-w-0 flex-auto items-center justify-center rounded-md px-3 py-1 text-xs font-medium break-keep text-muted-foreground hover:text-foreground aria-selected:bg-selected aria-selected:text-foreground aria-selected:shadow-selected"
          >
            {model.text(label)}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value="history" keepMounted className="min-w-0 outline-none">
        <Failures headingHidden />
      </Tabs.Panel>
      <Tabs.Panel value="tools" keepMounted className="min-w-0 outline-none">
        <Preferences />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
