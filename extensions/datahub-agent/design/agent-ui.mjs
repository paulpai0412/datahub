// UI review only: no network, persistence, credentials, or runtime commands.
const dialog = document.querySelector("#history-dialog");
const workbench = document.querySelector("#workbench");
const details = document.querySelector("#details");
const detailsButton = document.querySelector("#details-button");

function showChoice(attribute, value, suffix) {
  for (const button of document.querySelectorAll(`[${attribute}]`)) {
    const selected = button.getAttribute(attribute) === value;
    button.setAttribute("aria-pressed", String(selected));
    document.getElementById(
      `${button.getAttribute(attribute)}-${suffix}`,
    ).hidden = !selected;
  }
}

function closeDetails(restoreFocus = false) {
  details.hidden = true;
  workbench.classList.remove("details-open");
  detailsButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) detailsButton.focus({ preventScroll: true });
}

function sizeDrawer() {
  const bounds = workbench.getBoundingClientRect();
  for (const [key, value] of Object.entries({
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  })) {
    dialog.style.setProperty(`--drawer-${key}`, `${value}px`);
  }
}

function openDrawer(view) {
  // Workspace is a header action and is also reachable from Settings/Sources.
  showPage("chat", false);
  closeDetails();
  showChoice("data-drawer", view, "drawer");
  sizeDrawer();
  dialog.showModal();
}

function showPage(page, moveFocus = true) {
  if (dialog.open) dialog.close();
  closeDetails();
  for (const name of ["chat", "sources", "settings"]) {
    document.getElementById(`${name}-page`).hidden = name !== page;
  }
  for (const button of document.querySelectorAll("[data-page]")) {
    if (button.dataset.page === page)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (moveFocus) {
    const target =
      page === "chat"
        ? document.querySelector("#history-button")
        : document.getElementById(`${page}-heading`);
    target.focus({ preventScroll: true });
  }
}

for (const button of document.querySelectorAll("[data-page]")) {
  button.addEventListener("click", () => showPage(button.dataset.page));
}
for (const [attribute, suffix] of [
  ["data-setting", "setting"],
  ["data-detail", "detail"],
  ["data-drawer", "drawer"],
]) {
  for (const button of document.querySelectorAll(`[${attribute}]`)) {
    button.addEventListener("click", () =>
      showChoice(attribute, button.getAttribute(attribute), suffix),
    );
  }
}
document
  .querySelector("#history-button")
  .addEventListener("click", () => openDrawer("history"));
document
  .querySelector("#workspace-button")
  .addEventListener("click", () => openDrawer("workspace"));
detailsButton.addEventListener("click", () => {
  if (!details.hidden) return closeDetails(true);
  if (dialog.open) dialog.close();
  details.hidden = false;
  workbench.classList.add("details-open");
  detailsButton.setAttribute("aria-expanded", "true");
  document.querySelector("#close-details").focus({ preventScroll: true });
});
document
  .querySelector("#close-details")
  .addEventListener("click", () => closeDetails(true));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dialog.open && !details.hidden) {
    event.preventDefault();
    closeDetails(true);
  }
});
window.addEventListener("resize", () => {
  if (dialog.open) sizeDrawer();
});
