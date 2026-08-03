"use client";

import React from "react";
import { CanvasDefinition } from "@/lib/canvas";
import CanvasElementView, { CanvasLiveData } from "@/components/CanvasElementView";

interface Props {
  definition: CanvasDefinition | null | undefined;
  live: CanvasLiveData;
}

/**
 * Rendu en lecture seule d'une composition de canvas (Lot 12, réf. UX2.1/12.2)
 * sur l'écran kiosk — remplace les blocs figés du Lot 4. Chaque élément est
 * positionné en absolu par pourcentage du cadre 16:9, triés par z_index.
 */
export default function CanvasRenderer({ definition, live }: Props) {
  const elements = (definition?.elements ?? []).filter((el) => el.visible);
  const sorted = [...elements].sort((a, b) => a.z_index - b.z_index);

  return (
    <div className="canvas-render-root">
      {sorted.map((el) => (
        <div
          key={el.id}
          className="canvas-render-element"
          style={{
            left: `${el.x}%`,
            top: `${el.y}%`,
            width: `${el.width}%`,
            height: `${el.height}%`,
            zIndex: el.z_index,
          }}
        >
          <CanvasElementView element={el} live={live} />
        </div>
      ))}
    </div>
  );
}
