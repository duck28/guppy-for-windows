import "@fontsource-variable/inter";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appWindow } from "./model/appWindow";
import { model } from "./model/GuppyModel";
import { ContentView } from "./ui/ContentView";

// Ask before closing while downloads are running.
void appWindow.onCloseRequested(model.shouldClose);
void model.launch();
createRoot(document.getElementById("root")!).render(<StrictMode><ContentView /></StrictMode>);

// No browser context menu (Reload, Inspect…) except in text fields.
document.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
});
