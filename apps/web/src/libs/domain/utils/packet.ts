export async function blobToArrayBuffer(
  blob: Blob,
): Promise<ArrayBuffer> {
  const fileReader = new FileReader();

  return new Promise((resolve, reject) => {
    fileReader.onloadend = () => {
      resolve(fileReader.result as ArrayBuffer);
    };

    fileReader.onerror = (error) => {
      reject(error);
    };

    fileReader.readAsArrayBuffer(blob);
  });
}
