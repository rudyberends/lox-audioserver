import http from 'http'; // Importing the HTTP module for server response handling
import axios from 'axios'; // Importing axios for making HTTP requests
import logger from '../utils/troxorlogger'; // Importing the custom logger for logging messages

/**
 * Proxies content from the original URL and sends it back to the client.
 * This function acts as a CORS proxy to prevent CORS issues when making 
 * requests to a different origin.
 *
 * @param {http.ServerResponse} res - The response object to send back to the client.
 * @param {string} url - The requested URL containing the original resource URL parameter.
 * @throws {Error} Throws an error if the original URL is not provided or if the request fails.
 *
 * @example
 * // Example usage in an HTTP server request handler
 * await corsProxy(response, request.url);
 */
export const corsProxy = async (res: http.ServerResponse, url: string) => {
  // Extract URL parameters from the incoming request
  const urlParams = new URLSearchParams(url.split('?')[1]);
  const originalUrl = urlParams.get('url'); // Get the 'url' parameter from the query

  // If the 'url' parameter is missing, return a 400 Bad Request response
  if (!originalUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request: Missing URL parameter');
    return; // Exit the function
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(originalUrl);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request: Invalid URL');
    return;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request: Unsupported protocol');
    return;
  }

  try {
    // Fetch the resource from the original URL using axios
    const response = await axios.get(originalUrl, {
      responseType: 'arraybuffer',
      timeout: 10_000,
      maxContentLength: 10 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Get the content type from the response headers
    const contentType = response.headers['content-type'];
    if (!contentType || !contentType.startsWith('image/')) {
      res.writeHead(415, { 'Content-Type': 'text/plain' });
      res.end('Unsupported Media Type');
      return;
    }

    // Set CORS headers to allow all origins and specific methods
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); // Allow specific methods
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // Allow specific headers

    // Send the response back to the client with the fetched content
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(response.data); // Send the content data back to the client
  } catch (error) {
    const statusCode = axios.isAxiosError(error) && error.response ? error.response.status : 500;
    const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    const message =
      safeStatus === 404
        ? 'Not Found'
        : safeStatus === 415
          ? 'Unsupported Media Type'
          : 'Failed to fetch resource';

    logger.debug(`[HTTP] Image proxy blocked or failed for ${originalUrl}: ${error}`);
    res.writeHead(safeStatus, { 'Content-Type': 'text/plain' });
    res.end(message); // End the response with an error message
  }
};
