// TSX and Pi's Jiti compile the same TS file differently. Give Node's native
// coverage collector distinct generated-script URLs so one source map cannot
// overwrite the other. Both maps still name the original source file.
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("file:") && /\.(?:ts|tsx)$/.test(result.url)) {
    result.url += "?pi-coverage-tsx";
  }
  return result;
}
