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
        // On the sidebar's tinted surface the selected tab is a raised tile marked by the red cap (ui.css) and icon, and
        // hover a step deeper than the sidebar; the strip marks its tab with the underline alone.
        "group-data-[variant=sidebar]/tabs-list:hover:bg-sidebar-accent group-data-[variant=sidebar]/tabs-list:aria-selected:bg-card group-data-[variant=sidebar]/tabs-list:aria-selected:hover:bg-card group-data-[variant=sidebar]/tabs-list:aria-selected:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_0_0_1px_var(--sidebar-border)]",
        "group-data-[variant=line]/tabs-list:aria-selected:bg-transparent group-data-[variant=line]/tabs-list:aria-selected:hover:bg-transparent",
        "focus-visible:border-ring/80 focus-visible:ring-[0.5px] focus-visible:ring-ring/80 relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-foreground group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:py-[calc(--spacing(1.25))] hover:text-foreground disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "group-data-[variant=sidebar]/tabs-list:rounded-lg group-data-[variant=sidebar]/tabs-list:border-0 group-data-[variant=sidebar]/tabs-list:pl-3 group-data-[variant=sidebar]/tabs-list:text-sm group-data-[variant=sidebar]/tabs-list:font-medium group-data-[variant=sidebar]/tabs-list:text-[color-mix(in_oklab,var(--muted-foreground)_55%,var(--sidebar-foreground))] group-data-[variant=sidebar]/tabs-list:hover:text-sidebar-foreground group-data-[variant=sidebar]/tabs-list:data-active:font-medium group-data-[variant=sidebar]/tabs-list:data-active:text-sidebar-foreground group-data-[variant=sidebar]/tabs-list:aria-selected:[&_svg]:text-sidebar-selected-foreground dark:group-data-[variant=sidebar]/tabs-list:text-muted-foreground dark:group-data-[variant=sidebar]/tabs-list:hover:text-sidebar-foreground dark:group-data-[variant=sidebar]/tabs-list:data-active:border-transparent dark:group-data-[variant=sidebar]/tabs-list:data-active:text-sidebar-foreground group-data-[variant=sidebar]/tabs-list:after:inset-y-2.5 group-data-[variant=sidebar]/tabs-list:after:left-0 group-data-[variant=sidebar]/tabs-list:after:right-auto group-data-[variant=sidebar]/tabs-list:after:w-[3px] group-data-[variant=sidebar]/tabs-list:after:rounded-full group-data-[variant=sidebar]/tabs-list:after:bg-sidebar-primary group-data-[variant=sidebar]/tabs-list:after:hidden",
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
