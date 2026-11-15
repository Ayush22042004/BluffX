// Nested dialogs own focus; parents must not steal it from portals.
export function manageDialogFocus(panel, onClose) {
  if (!panel) return () => {};
  const previous = document.activeElement;
  const visible = (el) =>
    el.getClientRects().length && !el.closest("[hidden], [inert]");
  const topmost = () =>
    [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .filter(visible)
      .at(-1);
  const controls = () =>
    [
      ...panel.querySelectorAll(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
      ),
    ].filter(visible);
  const focusFirst = () => (controls()[0] || panel).focus();
  if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
  if (topmost() === panel) focusFirst();
  const key = (e) => {
    if (topmost() !== panel) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== "Tab") return;
    const list = controls(),
      first = list[0],
      last = list.at(-1);
    if (!first) {
      e.preventDefault();
      panel.focus();
    } else if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === panel)
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const focus = (e) => {
    if (topmost() === panel && !panel.contains(e.target)) focusFirst();
  };
  document.addEventListener("keydown", key);
  document.addEventListener("focusin", focus);
  return () => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("focusin", focus);
    if (previous?.isConnected) previous.focus();
  };
}
