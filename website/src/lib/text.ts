/** Escapes HTML and renders backtick spans as <code>; used for step bodies authored in content/site.ts. */
export function renderInlineCode(body: string): string {
  return body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
