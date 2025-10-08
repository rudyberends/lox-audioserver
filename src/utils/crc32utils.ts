/**
 * Asynchronously calculates the CRC32 checksum of the provided data string.
 * 
 * @param {string} data - The input string for which to calculate the CRC32 checksum.
 * @returns {Promise<string>} - A promise that resolves to the CRC32 checksum in hexadecimal format.
 */
export async function asyncCrc32(data: string): Promise<string> {
  // Dynamically import the crc module
  const { crc32 } = await import('crc');

  // Compute the CRC32 checksum
  const checksum = crc32(data);

  // Convert checksum to hexadecimal and ensure it has 8 characters
  return (checksum >>> 0).toString(16).padStart(8, '0');
}
