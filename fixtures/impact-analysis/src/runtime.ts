export async function loadRuntime(name: string): Promise<unknown> {
  return import(name);
}
