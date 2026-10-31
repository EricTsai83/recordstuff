/**
 * The picture of a search that found nothing: an open folder seen from the front, its inside showing and holding only
 * the dashed outline of a recording that is not there, drawn in the theme's tokens so it follows the light and dark schemes.
 */
export function NoMatchArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true" focusable="false">
      <path d="M14 24a6 6 0 0 1 6-6h17l6 7h33a6 6 0 0 1 6 6v40H14z" className="fill-primary/40" />
      <rect x="20" y="32" width="56" height="34" rx="4" className="fill-background" />
      <rect
        x="31"
        y="38"
        width="34"
        height="20"
        rx="4"
        fill="none"
        strokeWidth="2.2"
        strokeDasharray="4 4"
        className="stroke-primary/60"
      />
      <path d="M9 61a5 5 0 0 1 5-5h68a5 5 0 0 1 4.9 6l-2.4 13A6 6 0 0 1 78.6 80H17.4a6 6 0 0 1-5.9-5L9.1 62z" className="fill-primary" />
    </svg>
  );
}
