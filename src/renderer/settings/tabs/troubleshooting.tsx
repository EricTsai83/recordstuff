/** Failure review and diagnostic actions have their own pages within Troubleshooting. */
import { useState } from "react";
import { createPortal } from "react-dom";
import { Tabs } from "@base-ui/react/tabs";
import * as model from "../settings-controller";
import { Failures } from "./failures";
import { Preferences } from "./preferences";

/** `head` is the page's fixed head; the section tabs stay there while a section scrolls. */
export function Troubleshooting({ head }: { head?: HTMLElement | null }) {
  const entry = model.view?.resultFocus ?? 0;
  const [selection, setSelection] = useState({ page: "history", entry });
  // An explicit entry selects history before main restores focus to its row. Keep the tab buttons mounted so
  // restoring focus cannot reselect the previously focused tools tab during that handoff.
  const page = selection.entry === entry ? selection.page : "history";
  const list = (
    <Tabs.List activateOnFocus aria-label={model.text("Troubleshooting sections")} className="darwin:wide:window-no-drag flex min-w-0 gap-6 border-b border-border">
      {([["history", "Failure history"], ["tools", "Diagnostics and cleanup"]] as const).map(([value, label]) => (
        <Tabs.Tab
          key={value}
          value={value}
          id={`troubleshooting-${value}-tab`}
          className="relative flex min-h-10 min-w-0 items-center justify-center pb-3 text-xs font-medium break-keep text-muted-foreground transition-colors duration-[80ms] ease-out hover:text-foreground aria-selected:font-semibold aria-selected:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 aria-selected:after:opacity-100"
        >
          {model.text(label)}
        </Tabs.Tab>
      ))}
    </Tabs.List>
  );
  return (
    <Tabs.Root value={page} onValueChange={(value) => {
      if (value === "history" || value === "tools") setSelection({ page: value, entry });
    }} orientation="horizontal" className={`flex min-w-0 flex-col gap-4${head ? " pt-2.5" : ""}`}>
      {head ? createPortal(list, head) : list}
      <Tabs.Panel value="history" keepMounted className="min-w-0 outline-none">
        <Failures headingHidden />
      </Tabs.Panel>
      <Tabs.Panel value="tools" keepMounted className="min-w-0 outline-none">
        <Preferences />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
