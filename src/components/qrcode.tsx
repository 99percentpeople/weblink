import { ComponentProps, onMount } from "solid-js";
import QRCodeJS from "qrcode";

export interface QRCodeProps
  extends ComponentProps<"canvas"> {
  value: string;
  dark?: string;
  light?: string;
  width?: number;
}

export const QRCode = (props: QRCodeProps) => {
  let canvasRef: HTMLCanvasElement | undefined;
  onMount(async () => {
    if (canvasRef) {
      await QRCodeJS.toCanvas(canvasRef, props.value, {
        color: {
          dark: props.dark ?? "#000000",
          light: props.light ?? "#ffffff",
        },
        width: props.width ?? 256,
      });
    }
  });
  return <canvas ref={canvasRef} {...props} />;
};

export async function downloadQRCode(
  value: string,
  name: string,
) {
  const svg = await QRCodeJS.toString(value);
  const blob = new Blob([svg], {
    type: "image/svg+xml",
  });

  const dataurl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = dataurl;
  a.download = name;
  a.click();
}
