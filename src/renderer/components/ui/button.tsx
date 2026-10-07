/**
 * App changes from the shadcn source (plan 069): the `media` variant (white controls over the player's black stage,
 * their icons shadowed to read on any picture), the `clip` size (a library card's whole face is one button), the
 * `icon-media` and `icon-xl` sizes (the player's and the full-screen page's controls) and the `wrap` variant (a row's
 * button wraps its label instead of running past the card, plan 067). `outline` is the app's quiet action: red text on a light red tint in light mode.
 * A filled primary action shares the sidebar's red with a contrasting label; media controls keep their own white palette.
 */
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "focus-ring group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-medium whitespace-nowrap transition-colors duration-150 outline-none select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        media:
          "rounded-full border-transparent bg-transparent text-media-foreground hover:bg-media-foreground/15 [--focus-color:var(--media-foreground)] [--focus-offset:1px] [&_svg]:drop-shadow-(--media-icon-shadow)",
        default: "bg-primary text-primary-foreground hover:bg-(--primary-hover) active:bg-(--primary-hover) [--focus-offset:2px]",
        outline:
          "border-transparent bg-chosen-surface text-chosen-text hover:bg-chosen-surface-hover active:bg-chosen-surface-hover aria-expanded:bg-chosen-surface-hover",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-accent active:bg-accent aria-expanded:bg-accent",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-chosen-text underline-offset-4 hover:underline",
      },
      size: {
        clip: "h-auto w-full flex-col items-stretch justify-start whitespace-normal p-0 text-left font-normal text-foreground",
        default:
          "h-7 gap-1.5 px-3 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1.5 px-3.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-8 [&_svg:not([class*='size-'])]:size-4",
        "icon-media": "size-[38px] [&_svg:not([class*='size-'])]:size-6",
        "icon-xl": "size-13 [&_svg:not([class*='size-'])]:size-8",
      },
      wrap: {
        true: "h-auto min-h-7 max-w-full text-left whitespace-normal",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      wrap: false,
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  wrap = false,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, wrap, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
