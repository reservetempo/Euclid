import "./style.css";
import { App } from "./ui/app";

const root = document.getElementById("app")!;
new App(root);

// Register the service worker for offline/installable use (production only, to
// avoid interfering with Vite's dev HMR).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support is best-effort */
    });
  });
}
