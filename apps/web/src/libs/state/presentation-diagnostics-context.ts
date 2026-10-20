import { createContext } from "solid-js";
import type { PresentationDiagnostics } from "@/libs/application/automation/presentation";
export const PresentationDiagnosticsContext =
  createContext<PresentationDiagnostics>();
