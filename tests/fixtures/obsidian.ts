export async function requestUrl(): Promise<never> {
  throw new Error("Unexpected real Obsidian transport in unit test");
}
