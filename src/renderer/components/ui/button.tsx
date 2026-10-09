/** App extensions: white media controls, whole-card buttons, larger player controls and wrapping labels. Standard variants follow shadcn base-mira; destructive is an outline in red ink. */
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring/80 focus-visible:ring-[0.5px] focus-visible:ring-ring/80 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        media:
          "rounded-full border-transparent bg-transparent text-media-foreground hover:bg-media-foreground/15 focus-visible:border-media-foreground focus-visible:ring-media-foreground/80 [&_svg]:drop-shadow-(--media-icon-shadow)",
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:bg-input/30",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // The outline frame of every other action, in red ink; the primary fill is already the brand red.
        destructive:
          "border-destructive-ink/50 text-destructive-ink hover:border-destructive-ink hover:bg-destructive/10 aria-expanded:bg-destructive/10 focus-visible:border-destructive-ink focus-visible:ring-destructive/80 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/80",
        // Every text link: ink at rest, the brand red with an underline under the pointer.
        link: "text-foreground decoration-current underline-offset-4 hover:underline hover:text-primary hover:[&>svg]:text-primary",
      },
      size: {
        clip: "h-auto w-full flex-col items-stretch justify-start whitespace-normal p-0 text-left font-normal text-foreground",
        default:
          "h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
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
