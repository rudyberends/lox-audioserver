import { promises as fs } from "fs";
import path from "path";
import logger from "./troxorlogger";

/**
 * Utility functions for safe and consistent file system operations.
 * This module provides standardized helpers for reading and writing JSON files,
 * ensuring directories exist, and resolving paths within the local `data` folder.
 *
 * These functions are designed for backend modules such as favoritesService,
 * playlist management, and configuration persistence.
 */

/**
 * Ensures that a directory exists. If it doesn't, it will be created recursively.
 * @param dirPath - The absolute or relative path to the directory to ensure.
 * @throws If directory creation fails for reasons other than existence.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    logger.warn(`[fileUtils] Failed to ensure directory ${dirPath}: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Reads and parses a JSON file asynchronously.
 * Returns `undefined` if the file does not exist or parsing fails.
 * @template T The expected shape of the returned JSON data.
 * @param filePath - Absolute or relative path to the JSON file.
 * @returns Parsed JSON content or `undefined` if the file is missing or unreadable.
 */
export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(`[fileUtils] Failed to read ${filePath}: ${(err as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Writes an object to a file in JSON format.
 * Automatically creates the file and overwrites if it already exists.
 * @param filePath - Absolute or relative path to the output file.
 * @param data - The data object to serialize as JSON.
 * @throws If writing the file fails.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  try {
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, json, "utf8");
  } catch (err) {
    logger.warn(`[fileUtils] Failed to write ${filePath}: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Resolves the absolute path to a subdirectory within the `/data` folder.
 * Ensures a consistent base path for all persistent data files.
 * @param subfolder - The subdirectory name (e.g. "favorites" or "playlists").
 * @returns The absolute path to the requested subfolder.
 */
export function resolveDataDir(subfolder: string): string {
  return path.join(path.resolve(process.cwd(), "data"), subfolder);
}