import { readFile } from "node:fs/promises";

type ErrorCtor<E extends Error> = new (msg: string) => E;

/**
 * Reads a JSON file from `path`, parses it, and passes the result to `parse`.
 * Throws an instance of `Err` on read failure or invalid JSON.
 */
export async function loadJsonFile<T, E extends Error>(
  path: string,
  parse: (json: unknown) => T,
  Err: ErrorCtor<E>,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Err(`cannot read file at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Err(`file is not valid JSON: ${path}`);
  }
  return parse(json);
}
