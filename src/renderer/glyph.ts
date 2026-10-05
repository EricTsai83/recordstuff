/**
 * The one way the pages draw an icon: a decorative SVG, hidden from assistive technology and never a tab stop, so
 * the control or text beside it is what is named. Each icon passes its own drawing attributes, on the svg or per path.
 */
const SVG = "http://www.w3.org/2000/svg";

export function glyph(viewBox: string, attributes: Record<string, string>, ...paths: Array<Record<string, string>>): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", viewBox); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  for (const path of paths) {
    const el = document.createElementNS(SVG, "path");
    for (const [name, value] of Object.entries(path)) el.setAttribute(name, value);
    svg.append(el);
  }
  return svg;
}
