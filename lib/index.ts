// Combined thermal printer library - single file version
// Original modules: types, escpos, network, usb, formatter, printer

import { PNG } from "pngjs";

// ===== TYPES =====

export interface MessageContent {
  name?: string;
  text?: string;
  image?: File;
  date?: string | Date;
  source?: string;
}

export interface PrinterConfig {
  ip?: string;
  useUSB?: boolean;
}

// ===== ESC/POS COMMAND BUILDER =====

export class ESCPOSEncoder {
  private buffer: Buffer[] = [];

  // Control commands
  private static readonly ESC = "\x1B";
  private static readonly GS = "\x1D";

  init(): this {
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.ESC}@`));
    return this;
  }

  text(content: string): this {
    this.buffer.push(Buffer.from(content));
    return this;
  }

  newline(count = 1): this {
    this.buffer.push(Buffer.from("\n".repeat(count)));
    return this;
  }

  align(position: "left" | "center" | "right"): this {
    const codes = { left: "\x00", center: "\x01", right: "\x02" };
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.ESC}a${codes[position]}`));
    return this;
  }

  bold(enabled = true): this {
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.ESC}E${enabled ? "\x01" : "\x00"}`));
    return this;
  }

  size(width: number, height: number): this {
    const w = Math.max(1, Math.min(8, width)) - 1;
    const h = Math.max(1, Math.min(8, height)) - 1;
    const size = (w << 4) | h;
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.GS}!${String.fromCharCode(size)}`));
    return this;
  }

  image(imageData: Buffer): this {
    this.buffer.push(imageData);
    return this;
  }

  cut(): this {
    // Epson printers use GS V A 0 for full cut
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.GS}VA\x00`));
    return this;
  }

  getBuffer(): Buffer {
    return Buffer.concat(this.buffer);
  }

  clear(): this {
    this.buffer = [];
    return this;
  }
}

// ===== NETWORK ADAPTER =====

export class NetworkAdapter {
  private socket: any = null;
  private host: string;
  private port: number;
  private connected = false;

  constructor(host: string, port = 9100) {
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) {
      return; // Already connected
    }

    const net = await import("net");
    this.socket = new net.Socket();

    // Set socket options for better reliability
    this.socket.setKeepAlive(true, 30000); // 30 second keepalive
    this.socket.setTimeout(10000); // 10 second timeout

    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.connected = true;
        this.socket.removeListener('error', onError);
        resolve();
      };

      const onError = (err: any) => {
        this.connected = false;
        this.socket.removeListener('connect', onConnect);
        reject(err);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
      
      // Handle connection loss
      this.socket.on('close', () => {
        this.connected = false;
      });

      this.socket.on('end', () => {
        this.connected = false;
      });

      this.socket.connect(this.port, this.host);
    });
  }

  async write(data: Buffer): Promise<void> {
    // Try to reconnect if connection is lost
    if (!this.connected || this.socket.destroyed) {
      console.log("[🧾] Network connection lost, attempting to reconnect...");
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const onError = (err: any) => {
        this.connected = false;
        
        // If it's a connection error, try once to reconnect and retry
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ENOTCONN') {
          console.log(`[🧾] Connection error (${err.code}), attempting recovery...`);
          
          // Try to reconnect and retry once
          this.connect()
            .then(() => {
              console.log("[🧾] Reconnected, retrying write...");
              return this.writeInternal(data);
            })
            .then(resolve)
            .catch(reject);
        } else {
          reject(err);
        }
      };

      this.socket.once('error', onError);
      this.writeInternal(data)
        .then(() => {
          this.socket.removeListener('error', onError);
          resolve();
        })
        .catch(() => {
          this.socket.removeListener('error', onError);
          onError(new Error('Write failed'));
        });
    });
  }

  private async writeInternal(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Ensure data is flushed to the printer
        if (this.socket.writableNeedDrain) {
          // Add timeout for drain event
          const drainTimeout = setTimeout(() => {
            resolve();
          }, 5000); // 5 second timeout
          
          this.socket.once('drain', () => {
            clearTimeout(drainTimeout);
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  close(): void {
    this.connected = false;
    this.socket?.destroy();
  }
}

// ===== USB ADAPTER =====
// USB Setup Requirements:
// • Linux: Install libudev-dev (Ubuntu/Debian: sudo apt-get install build-essential libudev-dev)
// • macOS: Should work out of the box
// • Windows: Use Zadig to install WinUSB driver for your USB device
// • Without proper drivers, you'll get LIBUSB_ERROR_NOT_SUPPORTED when opening devices

let usb: any = null;
let USB_AVAILABLE = false;

try {
  const usbModule = require("usb");
  usb = usbModule.usb;
  USB_AVAILABLE = true;
} catch (error) {
  console.log("[🧾] USB module not available, install with: bun add usb");
  USB_AVAILABLE = false;
}

export class USBAdapter {
  private device: any = null;
  private endpoint: any = null;
  private interface: any = null;

  constructor() {
    if (!USB_AVAILABLE) {
      throw new Error("USB not available. Install with: bun add usb");
    }

    // Find first printer device
    const devices = usb.getDeviceList();
    
    for (const device of devices) {
      try {
        if (this.isPrinter(device)) {
          this.device = device;
          break;
        }
      } catch (e) {
        // Skip devices that can't be read
      }
    }

    if (!this.device) {
      throw new Error("No USB printer found");
    }
  }

  private isPrinter(device: any): boolean {
    try {
      const descriptor = device.deviceDescriptor;
      const vendorId = descriptor.idVendor;
      
      // Check for known thermal printer vendors
      const thermalPrinterVendors = [
        0x04b8, // Epson
        0x0456, // Analog Devices
        0x0416, // Winbond Electronics
        0x0519, // Star Micronics
        0x0DD4  // Custom
      ];
      
      if (thermalPrinterVendors.includes(vendorId)) {
        return true;
      }
      
      const config = device.configDescriptor;
      if (!config?.interfaces) {
        return false;
      }

      for (const iface of config.interfaces) {
        for (const setting of iface) {
          // Check for printer class (7) or vendor-specific (255) which some thermal printers use
          if (setting.bInterfaceClass === 7 || setting.bInterfaceClass === 255) {
            return true;
          }
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async connect(): Promise<void> {
    console.log("[USB] ===== USB CONNECTION START =====");
    console.log("[USB] Opening USB device...");
    this.device.open();
    
    const descriptor = this.device.deviceDescriptor;
    console.log("[USB] Device descriptor:");
    console.log("[USB]   - Vendor ID:", `0x${descriptor.idVendor.toString(16).padStart(4, '0')}`);
    console.log("[USB]   - Product ID:", `0x${descriptor.idProduct.toString(16).padStart(4, '0')}`);
    console.log("[USB]   - Manufacturer:", descriptor.iManufacturer);
    console.log("[USB]   - Product:", descriptor.iProduct);
    
    const config = this.device.configDescriptor;
    console.log("[USB] Configuration descriptor:");
    console.log("[USB]   - Number of interfaces:", config.interfaces.length);
    
    // CRITICAL: Interface selection matters!
    // Interface 0 (class 7) is often the CUPS/driver interface, NOT raw ESC/POS
    // We need vendor-specific (255) or the "Built-in USB" ESC/POS interface
    // Collect all candidate interfaces first, then try in priority order
    
    interface Candidate {
      iface: any;
      index: number;
      setting: any;
      priority: number; // Lower = higher priority
    }
    
    const candidates: Candidate[] = [];
    
    for (let i = 0; i < config.interfaces.length; i++) {
      const iface = config.interfaces[i];
      const setting = iface[0];
      console.log(`[USB] Interface ${i}:`);
      console.log(`[USB]   - Interface number:`, setting.bInterfaceNumber);
      const classDesc = setting.bInterfaceClass === 7 ? "(Printer Class - CUPS/driver)" : 
                       setting.bInterfaceClass === 255 ? "(Vendor-specific - raw ESC/POS)" : 
                       "(Other)";
      console.log(`[USB]   - Class:`, setting.bInterfaceClass, classDesc);
      console.log(`[USB]   - Subclass:`, setting.bInterfaceSubClass);
      console.log(`[USB]   - Protocol:`, setting.bInterfaceProtocol);
      console.log(`[USB]   - Number of endpoints:`, setting.endpoints.length);
      
      for (let j = 0; j < setting.endpoints.length; j++) {
        const ep = setting.endpoints[j];
        const isOut = (ep.bEndpointAddress & 0x80) === 0;
        console.log(`[USB]   Endpoint ${j}:`);
        console.log(`[USB]     - Address:`, `0x${ep.bEndpointAddress.toString(16).padStart(2, '0')}`, isOut ? "(OUT)" : "(IN)");
        console.log(`[USB]     - Type:`, ep.bmAttributes & 0x03, (ep.bmAttributes & 0x03) === 2 ? "(Bulk)" : "");
        console.log(`[USB]     - Max packet size:`, ep.wMaxPacketSize);
      }
      
      // Check for bulk OUT endpoint
      const hasBulkOut = setting.endpoints.some((ep: any) => 
        (ep.bEndpointAddress & 0x80) === 0 && (ep.bmAttributes & 0x03) === 2
      );
      
      if (hasBulkOut) {
        // Priority: vendor-specific (255) = 1, other classes with bulk OUT = 2, printer class (7) = 3
        let priority = 3; // Default: printer class (CUPS/driver)
        if (setting.bInterfaceClass === 255) {
          priority = 1; // Vendor-specific (raw ESC/POS)
        } else if (setting.bInterfaceClass !== 7) {
          priority = 2; // Other classes (might be "Built-in USB" ESC/POS interface)
        }
        candidates.push({iface, index: i, setting, priority});
        console.log(`[USB]   → Added as candidate (priority ${priority})`);
      }
    }
    
    // Sort by priority (vendor-specific first)
    candidates.sort((a, b) => a.priority - b.priority);
    
    console.log(`[USB] Found ${candidates.length} candidate interface(s), trying in priority order...`);
    
    // Try interfaces in priority order
    for (const candidate of candidates) {
      const {setting} = candidate;
      try {
        console.log(`[USB] Attempting to claim interface ${candidate.index} (class ${setting.bInterfaceClass})...`);
        this.interface = this.device.interface(setting.bInterfaceNumber);
        this.interface.claim();
        console.log(`[USB] ✓ Interface ${candidate.index} claimed successfully`);
        
        const outEndpoint = setting.endpoints.find((ep: any) => 
          (ep.bEndpointAddress & 0x80) === 0 && (ep.bmAttributes & 0x03) === 2 // Bulk OUT
        );
        if (outEndpoint) {
          console.log(`[USB] Using OUT endpoint:`, `0x${outEndpoint.bEndpointAddress.toString(16).padStart(2, '0')}`);
          this.endpoint = this.interface.endpoint(outEndpoint.bEndpointAddress);
          console.log("[USB] ===== USB CONNECTION SUCCESS =====");
          
          if (setting.bInterfaceClass === 7) {
            console.log(`[USB] ⚠️  WARNING: Using Printer Class interface (7) - this may be CUPS/driver interface!`);
            console.log(`[USB]    If prints are blank, configure printer to "Built-in USB" ESC/POS mode:`);
            console.log(`[USB]    1. Power on while holding FEED button`);
            console.log(`[USB]    2. Navigate to Mode 17: Interface Selection`);
            console.log(`[USB]    3. Set to "Built-in USB" (option 2)`);
            console.log(`[USB]    4. Also remove printer from macOS System Settings → Printers`);
          } else if (setting.bInterfaceClass === 255) {
            console.log(`[USB] ✓ Using Vendor-specific interface (255) - this should be raw ESC/POS!`);
          }
          return;
        } else {
          console.log(`[USB] No bulk OUT endpoint found in interface ${candidate.index}`);
          this.interface.release();
          this.interface = null;
        }
      } catch (e: any) {
        console.error(`[USB] Failed to claim interface ${candidate.index}:`, e?.message || e);
        if (this.interface) {
          try {
            this.interface.release();
          } catch {}
          this.interface = null;
        }
        continue;
      }
    }

    console.error("[USB] ===== USB CONNECTION FAILED =====");
    throw new Error("No usable endpoint found");
  }

  async write(data: Buffer): Promise<void> {
    console.log("[USB] ===== USB WRITE START =====");
    console.log("[USB] Data size:", data.length, "bytes");
    console.log("[USB] Data as string (first 200 chars):", data.toString().slice(0, 200).replace(/[\x00-\x1F\x7F-\xFF]/g, (c) => {
      const code = c.charCodeAt(0);
      if (code === 0x0A) return '\\n';
      if (code === 0x0D) return '\\r';
      if (code === 0x1B) return '\\x1B';
      return `\\x${code.toString(16).padStart(2, '0')}`;
    }));
    console.log("[USB] First 64 bytes:", Array.from(data.slice(0, 64)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    if (data.length > 64) {
      console.log("[USB] Last 64 bytes:", Array.from(data.slice(-64)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    }
    
    // Find GS v 0 command
    const gsvIndex = data.indexOf(Buffer.from([0x1D, 0x76, 0x30]));
    if (gsvIndex >= 0) {
      console.log("[USB] GS v 0 command found at offset:", gsvIndex);
      const headerEnd = gsvIndex + 8; // GS v 0 header is 8 bytes
      console.log("[USB] GS v 0 header (8 bytes):", Array.from(data.slice(gsvIndex, headerEnd)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
      
      // Extract image command size from header
      const xL = data[gsvIndex + 4];
      const xH = data[gsvIndex + 5];
      const yL = data[gsvIndex + 6];
      const yH = data[gsvIndex + 7];
      const bytesPerRow = xL + (xH << 8);
      const heightDots = yL + (yH << 8);
      const bitmapSize = bytesPerRow * heightDots;
      const imageCommandEnd = gsvIndex + 8 + bitmapSize;
      
      console.log(`[USB] Image dimensions: ${bytesPerRow} bytes × ${heightDots} dots = ${bitmapSize} bytes bitmap`);
      
      // Split data: before image, image command, after image
      const beforeImage = data.slice(0, gsvIndex);
      const imageCommand = data.slice(gsvIndex, imageCommandEnd); // Header + bitmap only
      const afterImage = data.slice(imageCommandEnd);
      
      console.log("[USB] Sending data in normal chunks");
      console.log("[USB] GS v 0 command:", imageCommand.length, "bytes");
      console.log("[USB] GS v 0 header:", Array.from(imageCommand.slice(0, 8)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
      
      const startTime = Date.now();
      const chunkSize = 64;
      
      // Send before image
      for (let i = 0; i < beforeImage.length; i += chunkSize) {
        const chunk = beforeImage.slice(i, i + chunkSize);
        await new Promise<void>((resolve, reject) => {
          this.endpoint.transfer(chunk, (error: any) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      
      // Send image command in chunks
      for (let i = 0; i < imageCommand.length; i += chunkSize) {
        const chunk = imageCommand.slice(i, i + chunkSize);
        await new Promise<void>((resolve, reject) => {
          this.endpoint.transfer(chunk, (error: any) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      
      // Send after image
      for (let i = 0; i < afterImage.length; i += chunkSize) {
        const chunk = afterImage.slice(i, i + chunkSize);
        await new Promise<void>((resolve, reject) => {
          this.endpoint.transfer(chunk, (error: any) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
      
      const duration = Date.now() - startTime;
      console.log("[USB] Transfer completed in", duration, "ms");
      // Give printer time to process - longer delay for text
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      // No GS v 0 command, send normally in chunks
      const chunkSize = 64;
      const startTime = Date.now();
      
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        await new Promise<void>((resolve, reject) => {
          this.endpoint.transfer(chunk, (error: any) => {
            if (error) {
              console.error(`[USB] Chunk ${i}-${i + chunk.length} failed:`, error);
              reject(error);
            } else {
              resolve();
            }
          });
        });
        if (i + chunkSize < data.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      
      const duration = Date.now() - startTime;
      console.log("[USB] Transfer completed in", duration, "ms");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log("[USB] ===== USB WRITE END =====");
  }

  close(): void {
    try {
      this.interface?.release();
    } catch (e) {
      // Ignore release errors
    }
    try {
      this.device?.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

export { USB_AVAILABLE };

// ===== MESSAGE FORMATTER =====

export class MessageFormatter {
	private encoder = new ESCPOSEncoder();

	async formatMessage(content: MessageContent): Promise<Buffer> {
		this.encoder.clear();

		// Initialize printer (ESC @) - CRITICAL
		this.encoder.init();

		// Build plain text message - EXACTLY like the original lp command
		let message = "";
		
		if (content.name) {
			message += content.name + "\n\n";
		}
		
		if (content.text) {
			message += content.text;
		}

		// Add image placeholder if image exists
		if (content.image && !content.text) {
			message += "[📸 photo attached]";
		}

		// Send plain text (no formatting commands) - just like lp -o raw
		this.encoder.text(message);

		// Add newlines at end (like original: \n\n\n\n\n\n)
		this.encoder.newline(6);

		// Image processing (if image provided)
		if (content.image) {
			try {
				const imageData = await this.processImage(content.image);
				this.encoder.text("\n"); // Line feed before image
				this.encoder.image(imageData);
				this.encoder.text("\n"); // Line feed after image
			} catch (error: any) {
				console.error("[FORMATTER] Image processing error:", error?.message || error);
				this.encoder.text("[Image Error]\n");
			}
		}

		const buffer = this.encoder.getBuffer();
		console.log("[FORMATTER] Sending buffer:", buffer.length, "bytes");
		console.log("[FORMATTER] First 64 bytes:", Array.from(buffer.slice(0, 64)).map(b => {
			if (b >= 32 && b <= 126) return `'${String.fromCharCode(b)}'`;
			return `0x${b.toString(16).padStart(2, '0')}`;
		}).join(' '));
		console.log("[FORMATTER] Buffer as string (printable chars):", buffer.toString().replace(/[\x00-\x1F\x7F-\xFF]/g, '?'));
		
		return buffer;
	}

	private normalizeText(text: string): string {
		return text
			.replace(/[""]/g, '"')
			.replace(/['']/g, "'")
			.replace(/[–—]/g, "-")
			.replace(/…/g, "...");
	}

	private wrapText(text: string, width: number): string {
		// Normalize Unicode characters first
		text = this.normalizeText(text);

		const words = text.split(" ");
		const lines: string[] = [];
		let currentLine = "";

		for (const word of words) {
			const testLine = currentLine ? `${currentLine} ${word}` : word;
			if (testLine.length <= width) {
				currentLine = testLine;
			} else {
				if (currentLine) lines.push(currentLine);
				currentLine = word;
			}
		}

		if (currentLine) lines.push(currentLine);
		return lines.join("\n");
	}

	private async processImage(imageFile: File): Promise<Buffer> {
		console.log("[IMAGE] ===== IMAGE PROCESSING START =====");
		console.log("[IMAGE] File details:");
		console.log("[IMAGE]   - Name:", imageFile.name);
		console.log("[IMAGE]   - Size:", imageFile.size, "bytes");
		console.log("[IMAGE]   - Type:", imageFile.type);
		console.log("[IMAGE]   - Last modified:", new Date(imageFile.lastModified).toISOString());
		
		// Convert File to Buffer
		console.log("[IMAGE] Converting File to Buffer...");
		const arrayBuffer = await imageFile.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		console.log("[IMAGE] Buffer created:", buffer.length, "bytes");
		console.log("[IMAGE] First 32 bytes:", Array.from(buffer.slice(0, 32)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
		
		// Parse PNG
		console.log("[IMAGE] Parsing PNG...");
		let png: PNG;
		try {
			png = PNG.sync.read(buffer);
			console.log("[IMAGE] PNG parsed successfully:");
			console.log("[IMAGE]   - Width:", png.width, "px");
			console.log("[IMAGE]   - Height:", png.height, "px");
			console.log("[IMAGE]   - Data length:", png.data.length, "bytes");
			console.log("[IMAGE]   - Expected data:", png.width * png.height * 4, "bytes");
			
			// Sample pixels from corners and center
			const samplePixels = [
				[0, 0], [png.width - 1, 0], [0, png.height - 1], 
				[png.width - 1, png.height - 1],
				[Math.floor(png.width/2), Math.floor(png.height/2)]
			];
			console.log("[IMAGE] Sample pixel values:");
			for (const [x, y] of samplePixels) {
				const idx = (y * png.width + x) * 4;
				if (idx + 3 < png.data.length) {
					const r = png.data[idx];
					const g = png.data[idx + 1];
					const b = png.data[idx + 2];
					const a = png.data[idx + 3];
					const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
					console.log(`[IMAGE]   Pixel [${x}, ${y}]: RGBA(${r},${g},${b},${a}) -> luminance=${lum} -> ${lum < 128 ? 'BLACK' : 'white'}`);
				}
			}
		} catch (error: any) {
			console.error("[IMAGE] PNG parse failed:", error?.message || error);
			throw new Error("Image must be PNG format");
		}
		
		// Resize if too large (thermal printers are usually 384px wide max)
		const MAX_WIDTH = 384;
		if (png.width > MAX_WIDTH) {
			const scale = MAX_WIDTH / png.width;
			const newWidth = MAX_WIDTH;
			const newHeight = Math.floor(png.height * scale);
			console.log(`[IMAGE] Resizing: ${png.width}x${png.height} -> ${newWidth}x${newHeight} (scale: ${scale.toFixed(3)})`);
			
			const resized = new PNG({ width: newWidth, height: newHeight });
			for (let y = 0; y < newHeight; y++) {
				for (let x = 0; x < newWidth; x++) {
					const srcX = Math.floor(x / scale);
					const srcY = Math.floor(y / scale);
					const srcIdx = (srcY * png.width + srcX) * 4;
					const dstIdx = (y * newWidth + x) * 4;
					
					if (srcIdx + 3 < png.data.length && dstIdx + 3 < resized.data.length) {
						resized.data[dstIdx] = png.data[srcIdx];
						resized.data[dstIdx + 1] = png.data[srcIdx + 1];
						resized.data[dstIdx + 2] = png.data[srcIdx + 2];
						resized.data[dstIdx + 3] = png.data[srcIdx + 3];
					}
				}
			}
			png = resized;
			console.log("[IMAGE] Resize complete");
		}

		console.log("[IMAGE] Converting to bitmap...");
		const result = this.convertToBitmap(png);
		console.log("[IMAGE] ===== IMAGE PROCESSING END =====");
		return result;
	}

	private convertToBitmap(png: PNG): Buffer {
		console.log("[BITMAP] ===== BITMAP CONVERSION START =====");
		const { width, height, data } = png;

		const bytesPerRow = Math.ceil(width / 8);
		const bitmap = Buffer.alloc(bytesPerRow * height);
		console.log("[BITMAP] Bitmap parameters:");
		console.log("[BITMAP]   - Image dimensions:", width, "x", height, "px");
		console.log("[BITMAP]   - Bytes per row:", bytesPerRow);
		console.log("[BITMAP]   - Total bitmap size:", bitmap.length, "bytes");
		console.log("[BITMAP]   - Expected size:", bytesPerRow * height, "bytes");

		let blackPixelCount = 0;
		let whitePixelCount = 0;
		let transparentPixelCount = 0;

		// Convert image to 1bpp raster format
		// Row order: top to bottom
		// Byte order: left to right
		// Bit order: MSB first (bit 7 = leftmost pixel)
		// Bit value: 1 = black (print dot), 0 = white (no dot)
		console.log("[BITMAP] Processing pixels...");
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const idx = (y * width + x) * 4;
				const r = data[idx];
				const g = data[idx + 1];
				const b_val = data[idx + 2];
				const alpha = data[idx + 3];
				
				// Skip transparent pixels (treat as white)
				if (alpha < 128) {
					transparentPixelCount++;
					continue;
				}
				
				// Convert to grayscale using standard weights
				const luminance = 0.299 * r + 0.587 * g + 0.114 * b_val;
				
				// Threshold: dark pixels become black (1), light pixels become white (0)
				const isBlack = luminance < 128;
				
				if (isBlack) {
					blackPixelCount++;
					// Calculate byte index and bit index
					const byteIndex = y * bytesPerRow + Math.floor(x / 8);
					const bitIndex = 7 - (x % 8); // MSB first (bit 7 = leftmost pixel)
					bitmap[byteIndex] |= 1 << bitIndex;
					
					// Log first few black pixels for debugging
					if (blackPixelCount <= 10) {
						console.log(`[BITMAP]   Black pixel #${blackPixelCount} at [${x}, ${y}]: RGB(${r},${g},${b_val}) -> lum=${Math.round(luminance)} -> byteIndex=${byteIndex}, bitIndex=${bitIndex}, byte=0x${bitmap[byteIndex].toString(16).padStart(2, '0')}`);
					}
				} else {
					whitePixelCount++;
				}
			}
		}

		console.log("[BITMAP] Pixel statistics:");
		console.log("[BITMAP]   - Black pixels:", blackPixelCount);
		console.log("[BITMAP]   - White pixels:", whitePixelCount);
		console.log("[BITMAP]   - Transparent pixels:", transparentPixelCount);
		console.log("[BITMAP]   - Total pixels:", width * height);

		// Analyze bitmap data
		const nonZeroBytes = bitmap.filter(b => b !== 0).length;
		console.log("[BITMAP] Bitmap data analysis:");
		console.log("[BITMAP]   - Non-zero bytes:", nonZeroBytes, "out of", bitmap.length, `(${(nonZeroBytes/bitmap.length*100).toFixed(1)}%)`);
		console.log("[BITMAP]   - Zero bytes:", bitmap.length - nonZeroBytes);
		
		if (nonZeroBytes === 0) {
			console.error("[BITMAP] ⚠️ WARNING: All bitmap bytes are zero! Image will print blank!");
		} else {
			const firstNonZero = bitmap.findIndex(b => b !== 0);
			const lastNonZero = bitmap.length - 1 - [...bitmap].reverse().findIndex(b => b !== 0);
			console.log("[BITMAP]   - First non-zero byte at index:", firstNonZero, `(row ${Math.floor(firstNonZero / bytesPerRow)}, byte ${firstNonZero % bytesPerRow})`);
			console.log("[BITMAP]   - Last non-zero byte at index:", lastNonZero, `(row ${Math.floor(lastNonZero / bytesPerRow)}, byte ${lastNonZero % bytesPerRow})`);
			
			// Sample bitmap data
			console.log("[BITMAP] Bitmap samples:");
			console.log("[BITMAP]   - First row (0-", Math.min(16, bytesPerRow), "bytes):", Array.from(bitmap.slice(0, Math.min(16, bytesPerRow))).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
			if (height > 1) {
				const middleRow = Math.floor(height / 2);
				const middleRowStart = middleRow * bytesPerRow;
				console.log(`[BITMAP]   - Middle row ${middleRow} (${middleRowStart}-${middleRowStart + Math.min(16, bytesPerRow)}):`, Array.from(bitmap.slice(middleRowStart, middleRowStart + Math.min(16, bytesPerRow))).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
			}
			if (height > 2) {
				const lastRowStart = (height - 1) * bytesPerRow;
				console.log(`[BITMAP]   - Last row ${height-1} (${lastRowStart}-${lastRowStart + Math.min(16, bytesPerRow)}):`, Array.from(bitmap.slice(lastRowStart, lastRowStart + Math.min(16, bytesPerRow))).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
			}
			
			// Show some non-zero bytes with their binary representation
			console.log("[BITMAP] Sample non-zero bytes:");
			let shown = 0;
			for (let i = 0; i < bitmap.length && shown < 10; i++) {
				if (bitmap[i] !== 0) {
					const row = Math.floor(i / bytesPerRow);
					const col = i % bytesPerRow;
					console.log(`[BITMAP]   Index ${i} (row ${row}, col ${col}): 0x${bitmap[i].toString(16).padStart(2, '0')} = ${bitmap[i].toString(2).padStart(8, '0')} (binary)`);
					shown++;
				}
			}
		}

		// GS v 0 (raster bit image) - standard ESC/POS command for TM-T20II
		// Format: GS v 0 m xL xH yL yH [bitmap data]
		const xL = bytesPerRow & 0xff;
		const xH = (bytesPerRow >> 8) & 0xff;
		const yL = height & 0xff;
		const yH = (height >> 8) & 0xff;
		const m = 0x00; // normal mode (1x width, 1x height)

		console.log("[BITMAP] ESC/POS command header:");
		console.log("[BITMAP]   - Width:", bytesPerRow, "bytes =", `0x${bytesPerRow.toString(16)}`, `(xL=0x${xL.toString(16).padStart(2, '0')}, xH=0x${xH.toString(16).padStart(2, '0')})`);
		console.log("[BITMAP]   - Height:", height, "dots =", `0x${height.toString(16)}`, `(yL=0x${yL.toString(16).padStart(2, '0')}, yH=0x${yH.toString(16).padStart(2, '0')})`);
		console.log("[BITMAP]   - Mode:", m, "(normal)");
		console.log("[BITMAP] Using GS v 0 (raster bit image) command");
		
		const header = Buffer.from([
			0x1D, 0x76, 0x30, m,    // GS v 0 m
			xL, xH, yL, yH          // width (bytes), height (dots)
		]);
		
		const command = Buffer.concat([header, bitmap]);
		
		console.log("[BITMAP] Header bytes (8 bytes):", Array.from(header).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
		console.log("[BITMAP] Header as hex string:", header.toString('hex'));

		console.log("[BITMAP] Full command:");
		console.log("[BITMAP]   - Total size:", command.length, "bytes");
		console.log("[BITMAP]   - Header size:", header.length, "bytes");
		console.log("[BITMAP]   - Bitmap size:", bitmap.length, "bytes");
		console.log("[BITMAP]   - First 32 bytes:", Array.from(command.slice(0, 32)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
		if (command.length > 32) {
			console.log("[BITMAP]   - Last 32 bytes:", Array.from(command.slice(-32)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
		}
		
		// CRITICAL CHECK: Verify bitmap data matches expected size
		const expectedBitmapSize = bytesPerRow * height;
		if (bitmap.length !== expectedBitmapSize) {
			console.error(`[BITMAP] ⚠️ BITMAP SIZE MISMATCH! Expected ${expectedBitmapSize} bytes, got ${bitmap.length}`);
		}
		if (command.length !== 8 + expectedBitmapSize) {
			console.error(`[BITMAP] ⚠️ COMMAND SIZE MISMATCH! Expected ${8 + expectedBitmapSize} bytes, got ${command.length}`);
		} else {
			console.log(`[BITMAP] ✓ Size validation passed: ${command.length} = 8 (header) + ${expectedBitmapSize} (bitmap)`);
		}
		
		console.log("[BITMAP] ===== BITMAP CONVERSION END =====");
		return command;
	}
}

// ===== PRINTER =====

export class Printer {
  private adapter: USBAdapter | NetworkAdapter | null = null;
  private formatter = new MessageFormatter();
  private config: PrinterConfig;
  private initialized = false;

  constructor(config: PrinterConfig = {}) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      if (this.config.ip) {
        // Network printer specified
        this.adapter = new NetworkAdapter(this.config.ip);
        await this.adapter.connect();
        console.log(`[🧾] Network printer connected (${this.config.ip})`);
      } else {
        // Try USB first (default)
        try {
          this.adapter = new USBAdapter();
          await this.adapter.connect();
          console.log("[🧾] USB printer connected");
        } catch (usbError) {
          console.log("[🧾] USB failed:", (usbError as Error).message);
          if (this.config.useUSB === false) {
            throw new Error("USB disabled and no IP provided. Use --ip=<address> or enable USB");
          }
          throw new Error("USB printer not found. Make sure printer is connected via USB.");
        }
      }

      this.initialized = true;
    } catch (error) {
      console.error("[🧾] Failed to initialize printer:", error);
      throw error;
    }
  }

  async printMessage(content: MessageContent): Promise<void> {
    await this.ensureInitialized();
    const commands = await this.formatter.formatMessage(content);
    await this.adapter!.write(commands);
    console.log(`[🧾] Printed`);
  }

  async getStatus(): Promise<{ online: boolean }> {
    return { online: this.initialized };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async close(): Promise<void> {
    this.adapter?.close();
    this.adapter = null;
    this.initialized = false;
  }
}

// ===== MAIN API =====
// Global instance
let printerInstance: Printer | null = null;

export function createPrinter(config: PrinterConfig = {}): Printer {
  if (!printerInstance) {
    printerInstance = new Printer(config);
  }
  return printerInstance;
}

