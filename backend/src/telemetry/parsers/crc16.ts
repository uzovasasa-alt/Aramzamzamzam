/**
 * CRC-16/ARC (он же CRC-16/IBM): полином 0x8005 в отражённом виде 0xA001, начальное значение 0.
 * Используется и в Teltonika Codec 8/8E, и в Wialon IPS 2.0.
 */
export function crc16Arc(data: Uint8Array, init = 0x0000): number {
  let crc = init;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}
