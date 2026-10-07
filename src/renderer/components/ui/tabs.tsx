"use client";
/** App extension: responsive navigation shares pressed-choice feedback and keeps its primary indicator. */

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { selectionStyles } from "./selection-styles";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
        sidebar: "gap-1 bg-transparent px-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        selectionStyles,
        // Navigation uses its indicator and icon colour without filling the selected tab.
        "group-data-[variant=sidebar]/tabs-list:aria-selected:bg-transparent group-data-[variant=sidebar]/tabs-list:aria-selected:hover:bg-transparent",
        "group-data-[variant=line]/tabs-list:aria-selected:bg-transparent group-data-[variant=line]/tabs-list:aria-selected:hover:bg-transparent",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-foreground group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:py-[calc(--spacing(1.25))] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "group-data-[variant=sidebar]/tabs-list:rounded-lg group-data-[variant=sidebar]/tabs-list:border-0 group-data-[variant=sidebar]/tabs-list:pl-4 group-data-[variant=sidebar]/tabs-list:text-sm group-data-[variant=sidebar]/tabs-list:font-bold group-data-[variant=sidebar]/tabs-list:text-sidebar-foreground group-data-[variant=sidebar]/tabs-list:data-active:font-bold group-data-[variant=sidebar]/tabs-list:data-active:text-sidebar-selected-foreground group-data-[variant=sidebar]/tabs-list:aria-selected:[&_svg]:text-sidebar-selected-foreground dark:group-data-[variant=sidebar]/tabs-list:text-sidebar-foreground dark:group-data-[variant=sidebar]/tabs-list:data-active:border-transparent dark:group-data-[variant=sidebar]/tabs-list:data-active:text-sidebar-selected-foreground group-data-[variant=sidebar]/tabs-list:after:inset-y-1.5 group-data-[variant=sidebar]/tabs-list:after:left-0 group-data-[variant=sidebar]/tabs-list:after:right-auto group-data-[variant=sidebar]/tabs-list:after:w-[3px] group-data-[variant=sidebar]/tabs-list:after:rounded-full group-data-[variant=sidebar]/tabs-list:after:bg-sidebar-primary group-data-[variant=sidebar]/tabs-list:data-active:after:opacity-100",
        "after:absolute after:bg-primary after:opacity-0 after:transition-opacity after:duration-[80ms] after:ease-out group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-xs/relaxed outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
