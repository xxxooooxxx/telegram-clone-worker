import { useEffect, useState } from "react";

export type Route =
  | { type: "wizard"; fromSavedId?: string }
  | { type: "task"; taskId: string }
  | { type: "paused" }
  | { type: "completed" }
  | { type: "bots" }
  | { type: "protocol-accounts" }
  | { type: "saved-tasks" }
  | { type: "empty" };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/");
  const kind = parts[0];
  if (kind === "wizard") {
    if (parts[1] === "from" && parts[2]) return { type: "wizard", fromSavedId: parts[2] };
    return { type: "wizard" };
  }
  if (kind === "task" && parts[1]) return { type: "task", taskId: parts[1] };
  if (kind === "paused") return { type: "paused" };
  if (kind === "completed") return { type: "completed" };
  if (kind === "bots") return { type: "bots" };
  if (kind === "protocol-accounts") return { type: "protocol-accounts" };
  if (kind === "saved-tasks") return { type: "saved-tasks" };
  return { type: "empty" };
}

export function navigate(path: string) {
  window.location.hash = path;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash());
  useEffect(() => {
    const onChange = () => {
      const next = parseHash();
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if ("startViewTransition" in document && !reduceMotion) {
        document.startViewTransition(() => setRoute(next));
      } else {
        setRoute(next);
      }
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
