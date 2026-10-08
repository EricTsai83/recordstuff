/**
 * App changes from the shadcn source: `thumbProps` passes a label and value text to the thumb, and the thumb aligns to
 * the track's edge. Plan 069 adds `variant="media"`, a thin translucent track with a white range and round thumb over
 * the player's black stage that takes a pointing hand, and `growOnHover`, the player's seek bar, whose track thickens
 * and whose thumb grows in only while the pointer is over it or it has focus (restored 2026-10-07). `variant="seek"` is
 * the media slider in the accent red, as YouTube's seek bar and a library card's preview bar draw it (2026-10-08).
 */
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbProps,
  controlClassName,
  variant = "default",
  growOnHover = false,
  ...props
}: SliderPrimitive.Root.Props & {
  thumbProps?: SliderPrimitive.Thumb.Props;
  controlClassName?: string;
  variant?: "default" | "media" | "seek";
  growOnHover?: boolean;
}) {
  const media = variant === "media" || variant === "seek";
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max];

  return (
    <SliderPrimitive.Root
      className={cn(
        "group/slider data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full",
        media && "cursor-pointer",
        className,
      )}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className={cn("relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col", controlClassName)}>
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "relative grow overflow-hidden rounded-md bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1",
            media &&
              "rounded-full bg-media-track data-[orientation=horizontal]:h-[3px]",
            growOnHover &&
              "origin-center transition-transform duration-100 ease-out group-hover/slider:data-[orientation=horizontal]:scale-y-200 group-active/slider:data-[orientation=horizontal]:scale-y-200",
          )}
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className={cn(
              "bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
              variant === "media" && "bg-media-foreground",
            )}
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            {...thumbProps}
            className={cn(
              "relative block size-3 shrink-0 rounded-md border border-ring bg-white transition-[color,box-shadow] select-none after:absolute after:-inset-2 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/30 disabled:pointer-events-none disabled:opacity-50",
              media &&
                "size-[13px] rounded-full border-0 bg-media-foreground shadow-[var(--media-thumb-shadow)] has-[:focus-visible]:ring-media-foreground/30",
              variant === "seek" && "bg-primary",
              growOnHover &&
                "scale-0 transition-[scale,box-shadow] duration-100 ease-out group-hover/slider:scale-100 group-active/slider:scale-100 has-focus-visible:scale-100",
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
