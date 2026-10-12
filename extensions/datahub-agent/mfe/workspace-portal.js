/** Shared placement for parent-owned content in Pi Web workspace slots.
 * Geometry is presentation only. No HTML, URL, theme or authority from Pi. */
export function validWorkspaceRect(value) {
  return value && !Array.isArray(value) &&
    ["left", "top", "width", "height"].every(k => Number.isFinite(value[k]) && Math.abs(value[k]) <= 20000) &&
    value.width > 0 && value.height > 0;
}
export function placeWorkspacePortal({ element, frame, rect: r, visible, display = "block" }) {
  if (!element || !validWorkspaceRect(r)) return;
  const bounds = frame.getBoundingClientRect();
  const left = Math.max(0, bounds.left, bounds.left + r.left);
  const top = Math.max(0, bounds.top, bounds.top + r.top);
  const right = Math.min(window.innerWidth, bounds.right, bounds.left + r.left + r.width);
  const bottom = Math.min(window.innerHeight, bounds.bottom, bounds.top + r.top + r.height);
  Object.assign(element.style, {
    display: visible && !document.hidden && right > left && bottom > top ? display : "none",
    left: `${bounds.left + r.left}px`, top: `${bounds.top + r.top}px`,
    width: `${r.width}px`, height: `${r.height}px`,
    clipPath: `inset(${Math.max(0, top - bounds.top - r.top)}px ${Math.max(0, bounds.left + r.left + r.width - right)}px ${Math.max(0, bounds.top + r.top + r.height - bottom)}px ${Math.max(0, left - bounds.left - r.left)}px)`,
  });
}
