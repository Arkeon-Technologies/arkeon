export function backgroundTask(promise: Promise<unknown>) {
  promise.catch((err) => console.error("[background]", err));
}
