/**
 * The picture of a search that found nothing: a magnifying glass with a small smiling face in its lens, a blush on
 * either cheek and a sparkle beside it, drawn in the theme's tokens so it follows the light and dark schemes.
 */
export function NoMatchArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true" focusable="false">
      <circle cx="48" cy="50" r="40" className="fill-primary/10" />
      <path d="M58.5 60.5 71 73" strokeWidth="9" strokeLinecap="round" className="stroke-primary" />
      <circle cx="44" cy="46" r="20" strokeWidth="5" className="fill-background stroke-primary" />
      <circle cx="37" cy="44" r="2.6" className="fill-foreground" />
      <circle cx="51" cy="44" r="2.6" className="fill-foreground" />
      <ellipse cx="33" cy="51" rx="3.4" ry="2.1" className="fill-primary/35" />
      <ellipse cx="55" cy="51" rx="3.4" ry="2.1" className="fill-primary/35" />
      <path d="M40.5 53.5q3.5 2.6 7 0" strokeWidth="2.4" strokeLinecap="round" fill="none" className="stroke-foreground" />
      <path d="M76 14q1.2 5.8 7 7-5.8 1.2-7 7-1.2-5.8-7-7 5.8-1.2 7-7Z" className="fill-primary/70" />
      <circle cx="18" cy="24" r="2.5" className="fill-primary/40" />
    </svg>
  );
}
