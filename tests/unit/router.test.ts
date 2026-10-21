import { routeFor, pathFor, type Route } from "../../src/ui/router"

test("each route round-trips through its own path", () => {
  const routes: Route[] = ["editor", "history", "settings"]
  for (const route of routes) {
    expect(routeFor(pathFor(route)), `${route} does not round-trip`).toBe(route)
  }
})

test("the editor is the root path", () => {
  expect(pathFor("editor")).toBe("/")
  expect(routeFor("/")).toBe("editor")
  expect(routeFor("")).toBe("editor")
})

test("a URL a human typed or copied is tolerated, not rejected", () => {
  // Trailing slashes and case are both things a person reasonably produces; neither should
  // land them somewhere other than where the URL plainly says.
  for (const path of ["/history", "/history/", "/History", "/HISTORY/"]) {
    expect(routeFor(path), `${path} did not resolve to history`).toBe("history")
  }
  for (const path of ["/settings", "/settings/", "/Settings"]) {
    expect(routeFor(path), `${path} did not resolve to settings`).toBe("settings")
  }
})

test("an unrecognised path lands on the document, never on a 404", () => {
  // This app has exactly one document. A mistyped path should show it, not an error page about
  // a vault the app could perfectly well have opened.
  for (const path of ["/nonsense", "/settings/extra", "/a/b/c"]) {
    expect(routeFor(path)).toBe("editor")
  }
})

test("a deployment served from a sub-path still routes", () => {
  // Matched by suffix rather than by equality, so the app does not assume it is mounted at the
  // domain root -- a host serving it under /app/ would otherwise route everything to the editor.
  expect(routeFor("/app/history")).toBe("history")
  expect(routeFor("/some/prefix/settings")).toBe("settings")
})
