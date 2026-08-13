"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

/* ── Screenshot helper — lives inside Canvas so it can access the GL renderer ── */

export function ScreenshotHelper({ captureRef }: { captureRef: React.MutableRefObject<(() => void) | null> }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    captureRef.current = () => {
      gl.render(scene, camera);
      const url = gl.domElement.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "van-load-plan.png";
      a.click();
    };
    return () => { captureRef.current = null; };
  }, [gl, scene, camera, captureRef]);
  return null;
}
