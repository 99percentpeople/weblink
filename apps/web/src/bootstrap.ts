import "@/global.css";
import { mountApplication } from "@/libs/state/application-bootstrap";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Check the root element in index.html.",
  );
}
if (window.location.pathname === "/close-window") {
  try {
    window.close();
  } catch (error) {
    console.warn(error);
  }
  window.location.replace("about:blank");
} else {
  mountApplication(root);
}
