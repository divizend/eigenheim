// URL routing for the views reachable once a vault is open (editor / history / settings).
//
// Ruling R28: the decisions -- what a path means, what a view's path is -- are DOM-free exports;
// `startRouter` is the wiring. This file has no Node types available.
//
// Why real paths rather than a `#fragment`: the fragment would need no server cooperation at
// all, but it also shows up in `location.hash`, which is the one part of a URL that is
// conventionally throwaway. These are real places in the app, so they get real paths --
// `vercel.json` carries the SPA rewrite that makes a reload or a deep link work, and
// `public/sw.js` already answers any `navigate` request from the cached shell, so deep links
// work offline too.

export type Route = "editor" | "history" | "settings"

/** The path a route lives at. */
export function pathFor(route: Route): string {
  return route === "editor" ? "/" : `/${route}`
}

/** Which route a pathname names.
 *
 * Anything unrecognised is the editor rather than a 404: this app has exactly one document, and
 * a mistyped path should land the user on it rather than on an error page about a vault it
 * could have shown them. Trailing slashes and case are both tolerated, because a URL typed or
 * copied by a human is not required to be canonical. */
export function routeFor(pathname: string): Route {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase()
  if (normalized.endsWith("/history")) return "history"
  if (normalized.endsWith("/settings")) return "settings"
  return "editor"
}

export interface RouterDeps {
  /** Renders a route. Called on every navigation, including Back/Forward. */
  render: (route: Route) => void
}

/** Starts routing: renders the current URL, and re-renders on Back/Forward.
 *
 * Returns a `go` function that navigates. Views call it instead of rendering each other
 * directly, so the URL and what is on screen can never disagree -- which is the whole point of
 * routing, and the reason this is a function the views are handed rather than something they
 * each reimplement. */
export function startRouter(deps: RouterDeps): (route: Route) => void {
  const go = (route: Route): void => {
    const path = pathFor(route)
    if (window.location.pathname !== path) window.history.pushState({ route }, "", path)
    deps.render(route)
  }

  window.addEventListener("popstate", () => {
    deps.render(routeFor(window.location.pathname))
  })

  deps.render(routeFor(window.location.pathname))
  return go
}
