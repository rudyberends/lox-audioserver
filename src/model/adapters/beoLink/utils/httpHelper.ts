import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import logger from '@/utils/troxorLogger';

/**
 * -----------------------------------------------------------------------------
 * BeoLink HTTP Helper
 * -----------------------------------------------------------------------------
 * Provides safe and consistent HTTP operations for BeoLink endpoints.
 *
 * Automatically handles proper headers, logging, and consistent error output.
 * -----------------------------------------------------------------------------
 */

interface BeoLinkRequestOptions extends AxiosRequestConfig {
  zoneId?: number;
  zoneName?: string;
}

/**
 * Executes a BeoLink POST command safely with proper headers and optional body.
 */
export async function postBeoLinkCommand(
  url: string,
  body?: Record<string, unknown>,
  options?: BeoLinkRequestOptions,
): Promise<AxiosResponse | void> {
  const axiosOpts: AxiosRequestConfig = {
    method: 'POST',
    responseType: 'text',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    ...options,
  };

  try {
    logger.debug(`[BeoLinkHTTP] POST → ${url}`);
    const response = await axios.post(url, body ?? {}, axiosOpts);
    logger.debug(`[BeoLinkHTTP] ${response.status} ${response.statusText} from ${url}`);
    return response;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = err.response?.data ?? err.message;
      logger.error(`[BeoLinkHTTP] POST failed (${url}): ${msg}`);
    } else {
      logger.error(`[BeoLinkHTTP] Unexpected POST error (${url}): ${String(err)}`);
    }
  }
}

/**
 * Executes a BeoLink PUT command (commonly used for setting volume).
 */
export async function putBeoLinkCommand(
  url: string,
  body: Record<string, unknown>,
  options?: BeoLinkRequestOptions,
): Promise<AxiosResponse | void> {
  const axiosOpts: AxiosRequestConfig = {
    method: 'PUT',
    responseType: 'text',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    ...options,
  };

  try {
    logger.debug(`[BeoLinkHTTP] PUT → ${url}`);
    const response = await axios.put(url, body, axiosOpts);
    logger.debug(`[BeoLinkHTTP] ${response.status} ${response.statusText} from ${url}`);
    return response;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = err.response?.data ?? err.message;
      logger.error(`[BeoLinkHTTP] PUT failed (${url}): ${msg}`);
    } else {
      logger.error(`[BeoLinkHTTP] Unexpected PUT error (${url}): ${String(err)}`);
    }
  }
}

/**
 * Executes a BeoLink DELETE command.
 */
export async function deleteBeoLinkCommand(
  url: string,
  options?: BeoLinkRequestOptions,
): Promise<void> {
  const axiosOpts: AxiosRequestConfig = {
    method: 'DELETE',
    responseType: 'text',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    ...options,
  };

  try {
    logger.debug(`[BeoLinkHTTP] DELETE → ${url}`);
    const response = await axios.delete(url, axiosOpts);
    logger.debug(`[BeoLinkHTTP] ${response.status} ${response.statusText} from ${url}`);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const msg = err.response?.data ?? err.message;
      logger.error(`[BeoLinkHTTP] DELETE failed (${url}): ${msg}`);
    } else {
      logger.error(`[BeoLinkHTTP] Unexpected DELETE error (${url}): ${String(err)}`);
    }
  }
}