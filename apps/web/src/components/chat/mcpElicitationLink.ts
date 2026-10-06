/**
 * Opens an MCP elicitation page in the external browser. Returns the message
 * to show when that fails, so the user can still open the URL by hand.
 */
export async function openMcpElicitationUrl(
  url: string,
  openExternal: ((url: string) => Promise<void>) | undefined,
): Promise<string | null> {
  try {
    if (openExternal === undefined) throw new Error("Link opening is unavailable.");
    await openExternal(url);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Couldn't open the browser: ${reason} Copy the URL and open it manually.`;
  }
}
