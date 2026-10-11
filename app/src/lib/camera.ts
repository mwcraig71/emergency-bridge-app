// Photo capture: Capacitor Camera on device, file input fallback on web.
// All captures are downscaled to 1024px max dimension (keeps uploads viable
// on poor field connections).
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';

export interface CapturedPhoto {
  dataUrl: string;
  takenAt: string;
}

function downscale(dataUrl: string, maxDim = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function captureNative(): Promise<CapturedPhoto> {
  const photo = await Camera.getPhoto({
    quality: 85,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Camera,
  });
  if (!photo.dataUrl) throw new Error('Camera returned no image');
  return {
    dataUrl: await downscale(photo.dataUrl),
    takenAt: new Date().toISOString(),
  };
}

function captureWeb(): Promise<CapturedPhoto> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    (input as unknown as { capture: string }).capture = 'environment';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file chosen'));
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          resolve({
            dataUrl: await downscale(reader.result as string),
            takenAt: new Date().toISOString(),
          });
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    };
    input.oncancel = () => reject(new Error('Capture cancelled'));
    input.click();
  });
}

/** Capture a photo, downscaled to 1024px. Throws on cancel/failure. */
export async function capturePhoto(): Promise<CapturedPhoto> {
  if (Capacitor.isNativePlatform()) {
    try {
      return await captureNative();
    } catch {
      return captureWeb(); // fall back if native capture denied
    }
  }
  return captureWeb();
}
