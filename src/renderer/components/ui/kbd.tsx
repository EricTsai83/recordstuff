/**
 * App change from the shadcn source (plan 069): `variant` and `size`. `inline` is a key shown inside a button, in the
 * button's own colour at 60% instead of on a muted fill; `md` is the app's 12px metadata size (plan 067).
 */
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const kbdVariants = cva(
  "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-xs px-1 font-sans font-medium select-none [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default:
          "bg-muted text-muted-foreground in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10",
        inline: "bg-transparent text-inherit opacity-60",
      },
      size: {
        default: "text-[0.625rem]",
        md: "text-[0.75rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Kbd({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(kbdVariants({ variant, size }), className)}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup, kbdVariants };
