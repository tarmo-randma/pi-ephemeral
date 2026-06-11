import type { CatalogProblem } from "./types.js";

export class CatalogValidationError extends Error {
  readonly severity: CatalogProblem["severity"];
  readonly code: string;
  readonly identity?: string;
  readonly path?: string;

  constructor(problem: CatalogProblem) {
    super(problem.message);
    this.name = "CatalogValidationError";
    this.severity = problem.severity;
    this.code = problem.code;
    this.identity = problem.identity;
    this.path = problem.path;
  }
}

export function errorProblem(code: string, message: string, details: Omit<CatalogProblem, "severity" | "code" | "message"> = {}): CatalogProblem {
  return { severity: "error", code, message, ...details };
}

export function warningProblem(code: string, message: string, details: Omit<CatalogProblem, "severity" | "code" | "message"> = {}): CatalogProblem {
  return { severity: "warning", code, message, ...details };
}
