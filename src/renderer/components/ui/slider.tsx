/**
 * App changes from the shadcn source: `thumbProps` passes a label and value text to the thumb, and the thumb aligns to
 * the track's edge. Plan 069 adds `variant="media"`, a white range and thumb over the player's black stage, and
 * `growOnHover`, a track that thickens while the pointer is over the slider, for the player's seek bar.
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
  variant = "default",
  growOnHover = false,
  ...props
}: SliderPrimitive.Root.Props & {
  thumbProps?: SliderPrimitive.Thumb.Props;
  variant?: "default" | "media";
  growOnHover?: boolean;
}) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max];

  return (
    <SliderPrimitive.Root
      className={cn(
        "group/slider data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full",
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
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "relative grow overflow-hidden rounded-md bg-muted select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1",
            growOnHover &&
              "group-hover/slider:data-[orientation=horizontal]:h-1.5",
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
              "relative block size-3 shrink-0 rounded-md border border-ring bg-white ring-ring/30 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-2 focus-visible:ring-2 focus-visible:outline-hidden active:ring-2 disabled:pointer-events-none disabled:opacity-50",
              variant === "media" && "border-media-foreground bg-media-foreground",
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
