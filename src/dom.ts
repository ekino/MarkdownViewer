import { t } from "./i18n";

export function addCopyButtons(container: HTMLElement): void {
  for (const pre of container.querySelectorAll("pre")) {
    if (!pre.querySelector("code")) continue;
    if (pre.querySelector(".copy-btn")) continue;

    (pre as HTMLElement).style.position = "relative";
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = t("code.copy");
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      if (!code) return;
      navigator.clipboard.writeText(code.textContent ?? "").then(() => {
        btn.textContent = t("code.copied");
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = t("code.copy");
          btn.classList.remove("copied");
        }, 2000);
      });
    });
    pre.appendChild(btn);
  }
}

export function addImageLightbox(
  container: HTMLElement,
  onImageClick: (img: HTMLImageElement) => void
): void {
  for (const img of container.querySelectorAll("img")) {
    (img as HTMLElement).style.cursor = "pointer";
    img.addEventListener("click", () => onImageClick(img as HTMLImageElement));
  }
}
