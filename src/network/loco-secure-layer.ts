/*
 * Created on Sun Jan 17 2021
 *
 * Copyright (c) storycraft. Licensed under the MIT Licence.
 */

import { CryptoStore } from '../crypto';
import { ChunkedArrayBufferList } from './chunk';
import { BiStream } from '../stream';

/**
 * Loco secure layer that encrypt outgoing packets
 */
export class LocoSecureLayer implements BiStream {
  private _stream: BiStream;
  private _crypto: CryptoStore;

  private _handshaked: boolean;

  private _dataChunks: ChunkedArrayBufferList;

  constructor(socket: BiStream, crypto: CryptoStore) {
    this._stream = socket;
    this._crypto = crypto;

    this._handshaked = false;
    this._dataChunks = new ChunkedArrayBufferList();
  }

  async read(buffer: Uint8Array): Promise<number | null> {
    let readSize = buffer.byteLength - this._dataChunks.byteLength;

    while (readSize > 0) {
      const headerBuffer = new Uint8Array(20);
      if (!await this._stream.read(headerBuffer)) return 0;
      const dataSize = new DataView(headerBuffer.buffer).getUint32(0, true) - 16;
      const iv = headerBuffer.slice(4, 20);

      const encryptedData = new Uint8Array(dataSize);
      if (!await this._stream.read(encryptedData)) return 0;
      this._dataChunks.append(this._crypto.toAESDecrypted(encryptedData, iv));

      readSize = buffer.byteLength - this._dataChunks.byteLength;
    }

    const data = this._dataChunks.toBuffer();
    this._dataChunks.clear();

    buffer.set(data.subarray(0, buffer.byteLength), 0);

    const extraLeft = data.byteLength - buffer.byteLength;
    if (extraLeft > 0) {
      this._dataChunks.append(data.slice(buffer.byteLength, data.byteLength));
    }

    return buffer.byteLength;
  }

  get ended(): boolean {
    return this._stream.ended;
  }

  get crypto(): CryptoStore {
    return this._crypto;
  }

  /**
   * @return {BiStream} original stream
   */
  get stream(): BiStream {
    return this._stream;
  }

  /**
   * @return {boolean} true if handshake sent.
   */
  get handshaked(): boolean {
    return this._handshaked;
  }

  async write(data: Uint8Array): Promise<number> {
    if (!this._handshaked) {
      await this.sendHandshake();
      this._handshaked = true;
    }

    const iv = this._crypto.randomCipherIV();
    const encrypted = this._crypto.toAESEncrypted(data, iv);

    const packetBuffer = new ArrayBuffer(encrypted.byteLength + 20);
    const packet = new Uint8Array(packetBuffer);

    new DataView(packetBuffer).setUint32(0, encrypted.byteLength + 16, true);

    packet.set(iv, 4);
    packet.set(encrypted, 20);

    return this._stream.write(packet);
  }

  protected async sendHandshake(): Promise<void> {
    const encryptedKey = this._crypto.getRSAEncryptedKey();
    const handshakeBuffer = new ArrayBuffer(12 + encryptedKey.byteLength);
    const handshakePacket = new Uint8Array(handshakeBuffer);

    const view = new DataView(handshakeBuffer);

    view.setUint32(0, encryptedKey.byteLength, true);
    view.setUint32(4, 12, true); // RSA OAEP SHA1 MGF1 SHA1
    view.setUint32(8, 2, true); // AES_CFB128 NOPADDING
    handshakePacket.set(encryptedKey, 12);

    await this._stream.write(handshakePacket);
  }

  close(): void {
    this._stream.close();
  }
}
