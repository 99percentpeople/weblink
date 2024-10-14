export async function convertImageToPNG(
  imageFile: File,
): Promise<Blob> {
  if (imageFile.type === "image/pmg") {
    return imageFile;
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(imageFile);
    img.onload = function () {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error(`can not get context "2d"`);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
      }, "image/png");
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      reject(new Error("图片加载失败"));
    };
    img.src = url;
  });
}
