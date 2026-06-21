// Cross-component notification bus. Anything in the app can publish a
// notification event; NotificationCenter listens and pushes it onto the bell.
export interface AppNotif {
  kind: "dm" | "press-mention";
  title: string;
  detail?: string;
}

const target = typeof window !== "undefined" ? new EventTarget() : null;

export function publishAppNotif(n: AppNotif) {
  if (!target) return;
  target.dispatchEvent(new CustomEvent("app-notif", { detail: n }));
}

export function subscribeAppNotif(cb: (n: AppNotif) => void): () => void {
  if (!target) return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<AppNotif>).detail);
  target.addEventListener("app-notif", handler);
  return () => target.removeEventListener("app-notif", handler);
}
